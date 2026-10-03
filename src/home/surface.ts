import { Effect } from "effect";
import { defaultConfigPath, type NqConfig } from "../config.ts";
import { saveNqModel, saveNqReasoning } from "../login.ts";
import { readCampaignMeta } from "../campaign/open.ts";
import { isCampaignError } from "../campaign/errors.ts";
import {
  closePlayHandle,
  openPlayHandle,
  type PlayHandle,
  type PlaySessionOptions,
} from "../play/session.ts";
import type { AgentSessionFactory } from "../play/types.ts";
import { createHomeAuth, modelDisplayName } from "./auth.ts";
import {
  displayReasoningName,
  emptyReasoningCatalog,
  type ReasoningCatalog,
  type ReasoningChoice,
} from "./reasoning_catalog.ts";
import {
  birthLibraryCampaign,
  deleteLibraryCampaign,
  defaultCampaignsDir,
  listLibraryCampaigns,
} from "./library.ts";
import { defaultPacksDir, listSeedPacks } from "./packs.ts";
import { type AlmanacEntry } from "@nq/local-inference/almanac.ts";
import {
  LOCAL_PROVIDER_ID,
  probeLocalInstallation,
  providerDisplayName,
  splitProviderRow,
} from "./providers.ts";
import {
  applyHomeSettings,
  ceilingForLocalContext,
  homeSettingsFromConfig,
  parseHomeSettings,
  REASONING_LEVELS,
  saveHomeSettings,
  type HomeSettings,
} from "./settings.ts";
import type {
  HomeAuth,
  HomeModel,
  HomeOpenCampaign,
  HomeSignedIn,
  HomeSnapshot,
  LocalEngineOptions,
  LocalModelSelection,
} from "./types.ts";
import { PLAYER_FAILURE } from "./types.ts";
import { HomeError, isHomeError } from "./errors.ts";
import { AlmanacBook, type HomeAlmanac } from "./almanac_book.ts";
import { LocalSetup } from "./local_setup.ts";
import { ProviderSignIn } from "./sign_in.ts";

export { HomeError, isHomeError, type HomeAlmanac };

export type HomeSurfaceOptions = {
  config: NqConfig;
  configPath?: string;
  packsDir?: string;
  campaignsDir?: string;
  factory?: AgentSessionFactory;
  illustrator?: PlaySessionOptions["illustrator"];
  endReasoning?: PlaySessionOptions["endReasoning"];
  /** Wakes a scale-to-zero remote Game Master; a no-op for other models. */
  warmModel?: (model: string | undefined) => void;
  makeFactory?: (model: string) => AgentSessionFactory;
  prepareModel?: (
    model: string | undefined,
    opts: {
      signal: AbortSignal;
      onProgress: (message: string) => void;
      /** The thinking level the Game Master will play at. */
      reasoning?: string;
      /** The player's own Almanac entries, which Auto reads first. */
      almanac?: readonly AlmanacEntry[];
    } & Partial<LocalEngineOptions>,
  ) => Promise<void>;
  auth?: HomeAuth;
  reasoningCatalog?: ReasoningCatalog;
  probeLocal?: () => Promise<boolean>;
  openBrowser?: (url: string) => Promise<void>;
  /**
   * Settings the player cannot change on this surface. They are applied at
   * start and win over every save, from Home or from the book.
   */
  fixedSettings?: Partial<HomeSettings>;
  /** False turns debug logging and log files off and hides them. Default true. */
  diagnostics?: boolean;
  /**
   * One Game Master and no choice of Provider or Model (the hosted book).
   * Home shows no sign-in, and the model is a fixed setting.
   */
  gameMaster?: FixedGameMaster;
};

export type FixedGameMaster = {
  /** What Home calls the Provider, e.g. "Neverending Quest". */
  provider: string;
  /** The `<provider>/<model>` selector the Game Master runs on. */
  model: string;
  /** What Home calls the Model. */
  name: string;
};

/** The single Provider and Model of a fixed Game Master, always connected. */
function fixedAuth(gm: FixedGameMaster): HomeAuth {
  const providerId = gm.model.slice(0, gm.model.indexOf("/"));
  return {
    listProviders: async () => [{ id: providerId, name: gm.provider, connected: true }],
    login: async () => {},
    listModels: async () => [{ selector: gm.model, name: gm.name }],
  };
}

/** Settings the book may change while a Campaign is open. */
export const LIVE_SETTING_KEYS = [
  "turnTimeoutSec",
  "hygieneN",
  "compactCeilingTokens",
  "compactSeedPercent",
  "playTranscriptTailRows",
  "maxTokens",
  "gmPersonality",
  "debug",
  "logPath",
] as const satisfies ReadonlyArray<keyof HomeSettings>;

export class HomeSurface {
  readonly config: NqConfig;
  readonly configPath: string;
  readonly packsDir: string;
  readonly campaignsDir: string;
  onChange?: () => void;

  private readonly auth: HomeAuth;
  private readonly makeFactory?: (model: string) => AgentSessionFactory;
  private readonly probeLocal: () => Promise<boolean>;
  private readonly prepareModel?: HomeSurfaceOptions["prepareModel"];
  private readonly openBrowser?: (url: string) => Promise<void>;
  private factory: AgentSessionFactory | undefined;
  private readonly illustrator?: PlaySessionOptions["illustrator"];
  private readonly endReasoning?: PlaySessionOptions["endReasoning"];
  private readonly warmModelHook?: HomeSurfaceOptions["warmModel"];
  private readonly fixed: Partial<HomeSettings>;
  private readonly diagnostics: boolean;
  private readonly gameMaster?: FixedGameMaster;
  private handle: PlayHandle | null = null;
  private openMeta: HomeOpenCampaign | null = null;
  private locked = false;
  private modelAbort: AbortController | null = null;
  private modelLoadGeneration = 0;
  private readonly local: LocalSetup;
  private readonly signIn: ProviderSignIn;
  private readonly reasoningCatalog: ReasoningCatalog;
  private readonly almanacBook: AlmanacBook;
  private leaving = false;

  constructor(opts: HomeSurfaceOptions) {
    this.config = opts.config;
    this.configPath = opts.configPath ?? defaultConfigPath();
    this.packsDir = opts.packsDir ?? defaultPacksDir();
    this.campaignsDir = opts.campaignsDir ?? defaultCampaignsDir();
    this.gameMaster = opts.gameMaster;
    this.auth = opts.gameMaster
      ? fixedAuth(opts.gameMaster)
      : (opts.auth ?? createHomeAuth());
    this.reasoningCatalog = opts.reasoningCatalog ?? emptyReasoningCatalog;
    this.factory = opts.factory;
    this.illustrator = opts.illustrator;
    this.makeFactory = opts.makeFactory;
    this.endReasoning = opts.endReasoning;
    this.warmModelHook = opts.warmModel;
    this.prepareModel = opts.prepareModel;
    this.probeLocal = opts.probeLocal ?? (() => probeLocalInstallation());
    this.openBrowser = opts.openBrowser;
    this.diagnostics = opts.diagnostics !== false;
    this.fixed = {
      ...opts.fixedSettings,
      ...(this.diagnostics ? {} : { debug: false, logPath: "" }),
      ...(opts.gameMaster ? { model: opts.gameMaster.model } : {}),
    };
    applyHomeSettings(this.config, {
      ...homeSettingsFromConfig(this.config),
      ...this.fixed,
    });
    this.almanacBook = new AlmanacBook(this.configPath, this.config, () => this.notify());
    this.local = new LocalSetup(this.configPath, this.config, () => this.notify());
    this.signIn = new ProviderSignIn(
      {
        auth: this.auth,
        probeLocal: this.probeLocal,
        ...(this.openBrowser ? { openBrowser: this.openBrowser } : {}),
        reasoningCatalog: this.reasoningCatalog,
        local: this.local,
        fixed: Boolean(opts.gameMaster),
        assertCanChoose: () => {
          if (this.handle) throw new HomeError("busy", PLAYER_FAILURE.busy);
          if (this.locked) throw new HomeError("locked", PLAYER_FAILURE.locked);
        },
        commit: (model, reasoning) => this.commitSelection(model, reasoning),
        cancelWarm: () => {
          this.modelLoadGeneration += 1;
          this.modelAbort?.abort();
          this.modelAbort = null;
        },
        notify: () => this.notify(),
      },
      opts.gameMaster
        ? fixedSignedIn(opts.gameMaster, opts.config.reasoning)
        : signedInFromConfig(opts.config),
    );
  }

  get play(): PlayHandle | null {
    return this.handle;
  }

  get factoryOrThrow(): AgentSessionFactory {
    if (!this.factory) {
      throw new HomeError("need_sign_in", PLAYER_FAILURE.needSignIn);
    }
    return this.factory;
  }

  async refreshLocal(): Promise<void> {
    this.signIn.localAvailable = await this.probeLocal();
    this.notify();
  }

  async snapshot(): Promise<HomeSnapshot> {
    this.signIn.localAvailable = await this.probeLocal();
    const [campaigns, packs, providers] = await Promise.all([
      listLibraryCampaigns(this.campaignsDir),
      listSeedPacks(this.packsDir),
      this.auth.listProviders(),
    ]);
    const row = splitProviderRow(providers, this.signIn.localAvailable);
    const onLocal =
      this.signIn.pendingProviderId === LOCAL_PROVIDER_ID ||
      this.signIn.signedIn?.providerId === LOCAL_PROVIDER_ID;
    const localProfiles =
      onLocal && this.signIn.models ? await this.local.profiles(this.signIn.models) : null;
    return {
      signedIn: this.signIn.signedIn,
      locked: this.locked,
      login: { ...this.signIn.login },
      providers: row,
      models: this.signIn.models,
      mmproj: this.local.mmproj,
      gpus: this.local.gpus,
      exl3xpu: this.local.exl3xpu ? { ...this.local.exl3xpu } : null,
      localProfiles,
      reasoning:
        this.signIn.login.phase === "awaiting_reasoning"
          ? this.signIn.reasoningChoices
          : null,
      campaigns,
      packs,
      settings: homeSettingsFromConfig(this.config),
      fixedSettings: Object.keys(this.fixed) as Array<keyof HomeSettings>,
      diagnostics: this.diagnostics,
      choosesGameMaster: !this.gameMaster,
      open: this.openMeta,
    };
  }

  startLogin(provider: string): Promise<void> {
    return this.signIn.start(provider);
  }

  completePrompt(text: string): Promise<void> {
    return this.signIn.completePrompt(text);
  }

  cancelLogin(): void {
    this.signIn.cancel();
  }

  pickModel(raw: string): Promise<void> {
    return this.signIn.pickModel(raw);
  }

  pickReasoning(raw: string): Promise<void> {
    return this.signIn.pickReasoning(raw);
  }

  async pickLocalModel(selection: LocalModelSelection): Promise<void> {
    if (this.handle) throw new HomeError("busy", PLAYER_FAILURE.busy);
    if (this.locked) throw new HomeError("locked", PLAYER_FAILURE.locked);
    if (
      this.signIn.pendingProviderId !== LOCAL_PROVIDER_ID ||
      this.signIn.login.phase !== "awaiting_local"
    ) {
      throw new HomeError("login", "This computer is not waiting for setup.");
    }
    const chosen = (this.signIn.models ?? []).find(
      (model) => model.selector === selection.model,
    );
    if (!chosen) throw new HomeError("login", PLAYER_FAILURE.noModels);
    const reasoning = selection.reasoning.trim();
    if (
      !REASONING_LEVELS.includes(reasoning as (typeof REASONING_LEVELS)[number])
    ) {
      throw new HomeError("login", "That thinking level is not available.");
    }
    const accepted = await this.local.accept(selection, chosen, this.signIn.models ?? []);
    this.signIn.models = accepted.models;
    await this.commitSelection(
      chosen,
      { id: reasoning, name: displayReasoningName(reasoning) },
      accepted.engine,
    );
  }

  /**
   * Downloads another engine build so the load page can offer the cards it
   * reaches. The Game Master already loaded, if any, keeps running.
   */
  async downloadLocalEngine(backend: string): Promise<void> {
    if (this.handle) throw new HomeError("busy", PLAYER_FAILURE.busy);
    if (
      this.signIn.pendingProviderId !== LOCAL_PROVIDER_ID ||
      this.signIn.login.phase !== "awaiting_local"
    ) {
      throw new HomeError("login", "This computer is not waiting for setup.");
    }
    await this.local.downloadEngine(backend);
  }

  async birthAndOpen(
    packId: string,
    title?: string,
  ): Promise<HomeOpenCampaign> {
    this.assertCanOpen();
    const generation = this.modelLoadGeneration;
    const packs = await listSeedPacks(this.packsDir);
    const pack = packs.find((p) => p.id === packId || p.name === packId);
    if (!pack) throw new HomeError("unknown_pack", PLAYER_FAILURE.unknownPack);
    const name = title?.trim() || pack.name;
    let born;
    try {
      born = await birthLibraryCampaign({
        packDir: pack.dir,
        title: name,
        campaignsDir: this.campaignsDir,
      });
    } catch (err) {
      if (isHomeError(err)) throw err;
      throw new HomeError("open_failed", PLAYER_FAILURE.openFailed);
    }
    return this.openPath(born.path, generation);
  }

  async openById(id: string): Promise<HomeOpenCampaign> {
    this.assertCanOpen();
    const generation = this.modelLoadGeneration;
    const campaigns = await listLibraryCampaigns(this.campaignsDir);
    const card = campaigns.find((c) => c.id === id);
    if (!card)
      throw new HomeError("unknown_campaign", PLAYER_FAILURE.unknownCampaign);
    return this.openPath(card.path, generation);
  }

  async deleteById(id: string): Promise<void> {
    if (this.handle || this.leaving) {
      throw new HomeError("busy", PLAYER_FAILURE.busy);
    }
    try {
      const deleted = await deleteLibraryCampaign(id, this.campaignsDir);
      if (!deleted) {
        throw new HomeError("unknown_campaign", PLAYER_FAILURE.unknownCampaign);
      }
      this.notify();
    } catch (err) {
      if (isHomeError(err)) throw err;
      throw new HomeError("delete_failed", PLAYER_FAILURE.deleteFailed);
    }
  }

  async openPath(
    campaignPath: string,
    modelLoadGeneration = this.modelLoadGeneration,
  ): Promise<HomeOpenCampaign> {
    this.assertCanOpen();
    const factory = this.factory;
    if (!factory)
      throw new HomeError("need_sign_in", PLAYER_FAILURE.needSignIn);
    try {
      await this.prepareSelectedModel(
        this.config.model,
        undefined,
        modelLoadGeneration,
      );
    } catch (error) {
      throw new HomeError("open_failed", modelUnavailableMessage(error));
    }
    try {
      const handle = await Effect.runPromise(
        openPlayHandle({
          path: campaignPath,
          factory,
          config: this.config,
          illustrator: this.illustrator,
          ...(this.config.model?.startsWith(`${LOCAL_PROVIDER_ID}/`) &&
          this.endReasoning
            ? { endReasoning: this.endReasoning }
            : {}),
        }),
      );
      const meta = await readCampaignMeta(handle.api.campaignPath);
      this.handle = handle;
      this.openMeta = {
        id: meta.id,
        name: meta.name,
        path: handle.api.campaignPath,
      };
      this.locked = true;
      this.signIn.login = { phase: "idle" };
      this.notify();
      return this.openMeta;
    } catch (err) {
      if (isHomeError(err)) throw err;
      throw new HomeError("open_failed", PLAYER_FAILURE.openFailed);
    }
  }

  warmModel(): void {
    this.warmModelHook?.(this.config.model);
  }

  async leave(): Promise<void> {
    if (this.leaving) return;
    const handle = this.handle;
    if (!handle) {
      this.openMeta = null;
      this.locked = false;
      this.notify();
      return;
    }
    this.leaving = true;
    try {
      await closePlayHandle(handle);
    } finally {
      this.handle = null;
      this.openMeta = null;
      this.locked = false;
      this.leaving = false;
      this.notify();
    }
  }

  async updateSettings(value: unknown): Promise<void> {
    if (this.handle || this.leaving) {
      throw new HomeError("busy", PLAYER_FAILURE.busy);
    }
    let settings;
    try {
      settings = parseHomeSettings(
        value && typeof value === "object" ? { ...value, ...this.fixed } : value,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Settings are invalid.";
      throw new HomeError("settings", message);
    }
    let profile: LocalEngineOptions | undefined;
    try {
      profile = await this.prepareSelectedModel(settings.model);
    } catch (error) {
      throw new HomeError("settings", modelUnavailableMessage(error));
    }
    if (profile && !("compactCeilingTokens" in this.fixed)) {
      settings.compactCeilingTokens = ceilingForLocalContext(
        settings.compactCeilingTokens,
        profile.contextTokens,
      );
    }
    await saveHomeSettings(this.configPath, settings);
    applyHomeSettings(this.config, settings);

    if (this.makeFactory) {
      this.factory = settings.model
        ? this.makeFactory(settings.model)
        : undefined;
    } else if (!settings.model) {
      this.factory = undefined;
    }
    if (this.gameMaster) {
      this.signIn.signedIn = fixedSignedIn(this.gameMaster, settings.reasoning);
    } else if (!settings.model) {
      this.signIn.signedIn = null;
    } else if (this.signIn.signedIn) {
      const reasoning = displayReasoningName(settings.reasoning);
      this.signIn.signedIn = {
        ...this.signIn.signedIn,
        modelSelector: settings.model,
        model: `${settings.model} · ${reasoning}`,
        reasoning,
      };
    }
    this.signIn.login = { phase: "idle" };
    this.notify();
  }

  /**
   * Settings the player may change from inside the book. Only the keys in
   * LIVE_SETTING_KEYS are taken; the rest stay as saved. The open Campaign
   * picks them up at once (Idle only).
   */
  async updatePlaySettings(value: unknown): Promise<void> {
    const handle = this.handle;
    if (!handle || this.leaving) {
      throw new HomeError("settings", "Open an adventure first.");
    }
    const incoming =
      value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = {
      ...homeSettingsFromConfig(this.config),
    };
    for (const key of LIVE_SETTING_KEYS) {
      if (key in incoming) merged[key] = incoming[key];
    }
    Object.assign(merged, this.fixed);
    let settings;
    try {
      settings = parseHomeSettings(merged);
    } catch (err) {
      throw new HomeError(
        "settings",
        err instanceof Error ? err.message : "Settings are invalid.",
      );
    }
    try {
      await handle.loop.applyLiveSettings({
        turnTimeoutMs: settings.turnTimeoutSec * 1000,
        hygieneN: settings.hygieneN,
        compactCeilingTokens: settings.compactCeilingTokens,
        compactSeedPercent: settings.compactSeedPercent,
        playTranscriptTailRows: settings.playTranscriptTailRows,
        gmPersonality: settings.gmPersonality.trim() || undefined,
        debug: settings.debug,
        logPath: settings.logPath.trim() || undefined,
      });
    } catch (err) {
      if (isCampaignError(err) && err.code === "busy") {
        throw new HomeError(
          "busy",
          "Wait for the Game Master to finish, then save again.",
        );
      }
      throw err;
    }
    await saveHomeSettings(this.configPath, settings);
    applyHomeSettings(this.config, settings);
    this.notify();
  }

  private assertCanOpen(): void {
    if (this.handle || this.leaving) {
      throw new HomeError("busy", PLAYER_FAILURE.busy);
    }
    if (!this.factory) {
      throw new HomeError("need_sign_in", PLAYER_FAILURE.needSignIn);
    }
  }

  /** Warm the Game Master; returns the local engine profile it loads with, if any. */
  private async prepareSelectedModel(
    model: string | undefined,
    local?: LocalEngineOptions,
    generation = this.modelLoadGeneration,
    reasoning = this.config.reasoning,
  ): Promise<LocalEngineOptions | undefined> {
    const profile =
      local ??
      (model?.startsWith(`${LOCAL_PROVIDER_ID}/`)
        ? await this.local.engineOptionsFor(model, this.signIn.models ?? [])
        : undefined);
    if (generation !== this.modelLoadGeneration) throw abortError();
    if (profile) await this.fitCeilingTo(profile.contextTokens);
    if (!this.prepareModel) return profile;
    const abort = new AbortController();
    this.modelAbort?.abort();
    this.modelAbort = abort;
    try {
      await this.prepareModel(model, {
        signal: abort.signal,
        onProgress: (message) => {
          this.signIn.setLogin({ phase: "working", message });
        },
        // the whole profile, not just the token counts: a cache or sampling
        // choice that stops here would leave the engine on its own defaults
        ...(profile ?? {}),
        // Auto picks sampling for the thinking level the Game Master plays at
        ...(reasoning ? { reasoning } : {}),
        almanac: await this.almanacBook.yours(),
      });
      if (generation !== this.modelLoadGeneration) throw abortError();
    } catch (error) {
      if (!isAbortError(error)) {
        console.error(`Game Master load failed: ${errorMessage(error)}`);
      }
      throw error;
    } finally {
      if (this.modelAbort === abort) this.modelAbort = null;
    }
    return profile;
  }

  /**
   * Keep the compact ceiling inside a local model's context: lower the saved
   * setting to LOCAL_CEILING_SHARE of it, unless it is lower already or this
   * surface fixes the ceiling.
   */
  private async fitCeilingTo(contextTokens: number): Promise<void> {
    if ("compactCeilingTokens" in this.fixed) return;
    const ceiling = ceilingForLocalContext(this.config.compactCeilingTokens, contextTokens);
    if (ceiling >= this.config.compactCeilingTokens) return;
    const settings = { ...homeSettingsFromConfig(this.config), compactCeilingTokens: ceiling };
    await saveHomeSettings(this.configPath, settings);
    applyHomeSettings(this.config, settings);
    this.notify();
  }

  private async commitSelection(
    model: HomeModel,
    reasoning?: ReasoningChoice,
    local?: LocalEngineOptions,
  ): Promise<void> {
    const generation = this.modelLoadGeneration;
    if (this.prepareModel) {
      const isLocal = model.selector.startsWith(`${LOCAL_PROVIDER_ID}/`);
      this.signIn.setLogin({
        phase: "working",
        message: isLocal
          ? "Warming the Game Master…"
          : "Preparing the Game Master…",
      });
      try {
        await this.prepareSelectedModel(
          model.selector,
          local,
          generation,
          reasoning?.id ?? this.config.reasoning,
        );
      } catch (error) {
        if (isAbortError(error)) {
          this.signIn.setLogin({ phase: "idle" });
        } else {
          this.signIn.setLogin({
            phase: "error",
            message: modelUnavailableMessage(error),
          });
        }
        return;
      }
    }
    if (local) {
      const settings = {
        ...homeSettingsFromConfig(this.config),
        model: model.selector,
        reasoning: reasoning?.id ?? this.config.reasoning,
        localContextTokens: local.contextTokens,
        localReasoningTokens: local.reasoningTokens,
        localCacheK: local.cacheK ?? this.config.localCacheK,
        localCacheV: local.cacheV ?? this.config.localCacheV,
        // save the whole profile the engine just loaded with, or the next warm
        // (Resume) reads a different one from config and reloads the model
        localTuning: local.tuning ?? this.config.localTuning,
        localKvOffload: local.kvOffload ?? this.config.localKvOffload,
        localFlashAttention:
          local.flashAttention ?? this.config.localFlashAttention,
        // unset is a choice too: Automatic clears a card saved earlier
        localGpu: local.gpu,
      };
      await saveHomeSettings(this.configPath, settings);
      applyHomeSettings(this.config, settings);
    } else {
      await saveNqModel(this.configPath, model.selector);
      this.config.model = model.selector;
      if (reasoning) {
        await saveNqReasoning(this.configPath, reasoning.id);
        this.config.reasoning = reasoning.id;
      }
    }
    if (this.makeFactory) this.factory = this.makeFactory(model.selector);
    const providerId =
      this.signIn.pendingProviderId ?? this.signIn.signedIn?.providerId ?? "";
    const reasoningName =
      reasoning?.name ??
      (this.config.reasoning
        ? displayReasoningName(this.config.reasoning)
        : undefined);
    this.signIn.signedIn = {
      providerId,
      provider: providerId
        ? providerDisplayName(providerId)
        : (this.signIn.signedIn?.provider ?? "Provider"),
      modelSelector: model.selector,
      model: reasoningName ? `${model.name} · ${reasoningName}` : model.name,
      reasoning: reasoningName,
    };
    this.signIn.pendingModel = null;
    this.signIn.reasoningChoices = null;
    this.signIn.setLogin({ phase: "idle" });
  }

  /** The Almanac: the player's entries first, then the book's, and every installed model. */
  almanac(): Promise<HomeAlmanac> {
    return this.almanacBook.read();
  }

  /** Writes one of the player's entries, new or edited; returns the stored entry. */
  saveAlmanacEntry(raw: unknown): Promise<AlmanacEntry> {
    return this.almanacBook.save(raw);
  }

  deleteAlmanacEntry(id: string): Promise<void> {
    return this.almanacBook.remove(id);
  }

  private notify(): void {
    this.onChange?.();
  }
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  return Object.assign(new Error("cancelled"), { name: "AbortError" });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function modelUnavailableMessage(error: unknown): string {
  return `${PLAYER_FAILURE.modelUnavailable}\n${errorMessage(error)}`;
}


function signedInFromConfig(config: NqConfig): HomeSignedIn | null {
  const selector = config.model?.trim();
  if (!selector) return null;
  const slash = selector.indexOf("/");
  const providerId = slash >= 0 ? selector.slice(0, slash) : "";
  const reasoning = config.reasoning?.trim();
  const reasoningName = reasoning ? displayReasoningName(reasoning) : undefined;
  const model = modelDisplayName(selector);
  return {
    providerId,
    provider: providerId ? providerDisplayName(providerId) : "Provider",
    modelSelector: selector,
    model: reasoningName ? `${model} · ${reasoningName}` : model,
    reasoning: reasoningName,
  };
}

/**
 * A book with one Game Master names only its Provider: which model plays,
 * and how hard it thinks, are the host's business, not the player's.
 */
function fixedSignedIn(gm: FixedGameMaster, reasoning: string | undefined): HomeSignedIn {
  const reasoningName = reasoning?.trim() ? displayReasoningName(reasoning) : undefined;
  return {
    providerId: gm.model.slice(0, gm.model.indexOf("/")),
    provider: gm.provider,
    modelSelector: gm.model,
    reasoning: reasoningName,
  };
}
