/**
 * "This computer" on Home: what the load page offers (projector files, the
 * cards each engine build reaches, the exl3xpu engine), each local model's
 * engine profile, and turning the load page's choices into a checked,
 * saved profile. Sign-in and warming the Game Master stay with HomeSurface.
 */
import { totalmem } from "node:os";
import type { NqConfig } from "../config.ts";
import {
  isLocalCacheType,
  LOCAL_CACHE_TYPES,
  sameLocalGpu,
  type LocalGpuList,
} from "@nq/local-inference/profile.ts";
import { parseLocalTuning } from "@nq/local-inference/tuning.ts";
import { HomeError } from "./errors.ts";
import {
  loadLocalProfiles,
  resolveLocalProfile,
  saveLocalProfile,
} from "./local_profiles.ts";
import {
  installLocalEngine,
  installLocalExl3xpu,
  listLocalGpus,
  listLocalMmproj,
  localExl3xpuInstalled,
  LOCAL_PROVIDER_ID,
  setLocalMmproj,
} from "./providers.ts";
import type {
  HomeExl3xpu,
  HomeMmproj,
  HomeModel,
  HomeSnapshot,
  LocalEngineOptions,
  LocalModelSelection,
} from "./types.ts";

/** The part of a local selector after `llama.cpp/`. */
export function localAlias(selector: string): string {
  return selector.slice(`${LOCAL_PROVIDER_ID}/`.length);
}

export function isLocalSelector(selector: string | undefined): boolean {
  return Boolean(selector?.startsWith(`${LOCAL_PROVIDER_ID}/`));
}

export class LocalSetup {
  mmproj: HomeMmproj[] | null = null;
  gpus: LocalGpuList | null = null;
  exl3xpu: HomeExl3xpu | null = null;

  constructor(
    private readonly configPath: string,
    private readonly config: NqConfig,
    private readonly notify: () => void,
  ) {}

  /** Read what the load page offers after signing in to `providerId`. */
  async refresh(providerId: string, models: readonly HomeModel[]): Promise<void> {
    const local = providerId === LOCAL_PROVIDER_ID;
    // projectors and cards only mean something for a model this computer runs
    this.mmproj = local ? await listLocalMmproj().catch(() => []) : null;
    this.gpus = local ? await listLocalGpus().catch(() => null) : null;
    // only a local sign-in with an EXL3 model installed shows the exl3xpu engine
    if (!local || !models.some((model) => model.engine)) {
      if (!this.exl3xpu?.downloading) this.exl3xpu = null;
      return;
    }
    if (this.exl3xpu?.downloading) return;
    this.exl3xpu = { installed: await localExl3xpuInstalled().catch(() => false) };
  }

  /**
   * Check the load page's choices for `chosen` and save them as that model's
   * profile. Returns the models list with any projector change applied, and
   * the engine options to warm with.
   */
  async accept(
    selection: LocalModelSelection,
    chosen: HomeModel,
    models: readonly HomeModel[],
  ): Promise<{ models: HomeModel[]; engine: LocalEngineOptions }> {
    if (!Number.isInteger(selection.contextTokens) || selection.contextTokens < 1) {
      throw new HomeError("login", "Context size must be a positive whole number.");
    }
    if (!Number.isInteger(selection.reasoningTokens) || selection.reasoningTokens < -1) {
      throw new HomeError("login", "Reasoning budget must be -1 or a whole number.");
    }
    let listed = [...models];
    if (selection.mmproj !== undefined) {
      const projector = selection.mmproj.trim();
      if (projector && !(this.mmproj ?? []).some((f) => f.path === projector)) {
        throw new HomeError("login", "That projector file is not available.");
      }
      await setLocalMmproj(localAlias(chosen.selector), projector || undefined);
      // the cached list is what the picker reopens on, so move it in step
      // rather than waiting for the next sign-in to re-read the installation
      listed = listed.map((model) => {
        if (model.selector !== chosen.selector) return model;
        const { mmproj: _previous, ...rest } = model;
        return projector ? { ...rest, mmproj: projector } : rest;
      });
    }
    if (
      selection.parallel !== undefined &&
      (!Number.isInteger(selection.parallel) || selection.parallel < 1 || selection.parallel > 16)
    ) {
      throw new HomeError("login", "Games at once must be a whole number from 1 to 16.");
    }
    if (selection.ramCacheGiB !== undefined) {
      // At most half the computer's RAM: the cache is pinned, so the system
      // cannot swap it out, and a 30 GiB cache on a 62 GiB machine left too
      // little for the Arc's driver, which crashed reclaiming memory.
      const spareGiB = Math.floor(totalmem() / 2 ** 30 / 2);
      if (
        !Number.isFinite(selection.ramCacheGiB) ||
        selection.ramCacheGiB < 0 ||
        selection.ramCacheGiB > spareGiB
      ) {
        throw new HomeError("login", `RAM cache must be between 0 and ${spareGiB} GiB.`);
      }
    }
    if (
      selection.gpu &&
      !(this.gpus?.gpus ?? []).some((gpu) => sameLocalGpu(gpu, selection.gpu))
    ) {
      throw new HomeError("login", "That GPU is not available.");
    }
    for (const [label, value] of [
      ["Key cache", selection.cacheK],
      ["Value cache", selection.cacheV],
    ] as const) {
      if (value !== undefined && !isLocalCacheType(value)) {
        throw new HomeError("login", `${label} must be one of ${LOCAL_CACHE_TYPES.join(", ")}.`);
      }
    }
    const gpu = selection.gpu
      ? { backend: selection.gpu.backend, device: selection.gpu.device, name: selection.gpu.name }
      : undefined;
    // the choices belong to this model from now on, even if the warm-up is cancelled
    await saveLocalProfile(this.configPath, localAlias(chosen.selector), {
      contextTokens: selection.contextTokens,
      reasoningTokens: selection.reasoningTokens,
      cacheK: selection.cacheK ?? this.config.localCacheK,
      cacheV: selection.cacheV ?? this.config.localCacheV,
      kvOffload: selection.kvOffload !== false,
      flashAttention: selection.flashAttention !== false,
      gpu: gpu ?? null,
      parallel: selection.parallel ?? 1,
      ramCacheGiB: selection.ramCacheGiB ?? 0,
    });
    return {
      models: listed,
      engine: {
        contextTokens: selection.contextTokens,
        reasoningTokens: selection.reasoningTokens,
        ...(selection.cacheK ? { cacheK: selection.cacheK } : {}),
        ...(selection.cacheV ? { cacheV: selection.cacheV } : {}),
        tuning: parseLocalTuning(selection.tuning as Record<string, unknown>),
        kvOffload: selection.kvOffload !== false,
        flashAttention: selection.flashAttention !== false,
        ...(gpu ? { gpu } : {}),
        parallel: selection.parallel ?? 1,
        ramCacheGiB: selection.ramCacheGiB ?? 0,
      },
    };
  }

  /**
   * Downloads another engine build so the load page can offer the cards it
   * reaches. The Game Master already loaded, if any, keeps running.
   */
  async downloadEngine(backend: string): Promise<void> {
    if (backend === "exl3xpu") {
      this.startExl3xpuDownload();
      return;
    }
    const wanted = this.gpus?.downloadable.find((candidate) => candidate === backend);
    if (!wanted) {
      throw new HomeError("login", "That engine is not offered here.");
    }
    try {
      await installLocalEngine(wanted);
    } catch (error) {
      throw new HomeError("login", `Could not download the ${wanted} engine: ${errorMessage(error)}`);
    }
    this.gpus = await listLocalGpus().catch(() => this.gpus);
    this.notify();
  }

  /** The engine profile of every listed local model, for the load page. */
  async profiles(models: readonly HomeModel[]): Promise<HomeSnapshot["localProfiles"]> {
    const profiles = await loadLocalProfiles(this.configPath);
    const out: NonNullable<HomeSnapshot["localProfiles"]> = {};
    for (const model of models) {
      if (!isLocalSelector(model.selector)) continue;
      out[model.selector] = resolveLocalProfile({
        alias: localAlias(model.selector),
        profiles,
        config: this.config,
        model: {
          ...(model.size !== undefined ? { size: model.size } : {}),
          ...(model.engine ? { engine: model.engine } : {}),
        },
        gpus: this.gpus?.gpus ?? [],
        ...(this.gpus?.primaryBackend ? { primaryBackend: this.gpus.primaryBackend } : {}),
      });
    }
    return out;
  }

  /**
   * How a local model warms outside the load page (Resume, opening a Campaign):
   * its saved profile, or the default the load page would have shown.
   */
  async engineOptionsFor(
    selector: string,
    models: readonly HomeModel[],
  ): Promise<LocalEngineOptions> {
    const alias = localAlias(selector);
    const profiles = await loadLocalProfiles(this.configPath);
    const listed = models.find((model) => model.selector === selector);
    const needsDefault = !profiles[alias] && this.config.model !== selector;
    const gpus = needsDefault
      ? (this.gpus ?? (await listLocalGpus().catch(() => null)))
      : this.gpus;
    const { profile } = resolveLocalProfile({
      alias,
      profiles,
      config: this.config,
      model: {
        ...(listed?.size !== undefined ? { size: listed.size } : {}),
        ...(listed?.engine ? { engine: listed.engine } : {}),
      },
      gpus: gpus?.gpus ?? [],
      ...(gpus?.primaryBackend ? { primaryBackend: gpus.primaryBackend } : {}),
    });
    return {
      contextTokens: profile.contextTokens,
      reasoningTokens: profile.reasoningTokens,
      cacheK: profile.cacheK,
      cacheV: profile.cacheV,
      tuning: this.config.localTuning,
      kvOffload: profile.kvOffload,
      flashAttention: profile.flashAttention,
      ...(profile.gpu ? { gpu: profile.gpu } : {}),
      parallel: profile.parallel,
      ramCacheGiB: profile.ramCacheGiB,
    };
  }

  /**
   * The exl3xpu download is several GB, so it runs in the background and the
   * load page follows it through the snapshot instead of one long request.
   */
  private startExl3xpuDownload(): void {
    if (this.exl3xpu?.downloading || this.exl3xpu?.installed) return;
    this.exl3xpu = { installed: false, downloading: "Starting the download…" };
    this.notify();
    let layer = "Downloading the exl3xpu engine.";
    let lastNotify = 0;
    void installLocalExl3xpu({
      onProgress: (progress) => {
        if (progress.received === undefined) layer = progress.message;
        const detail =
          progress.received !== undefined && progress.total
            ? ` (${(progress.received / 1e9).toFixed(2)} of ${(progress.total / 1e9).toFixed(2)} GB)`
            : "";
        this.exl3xpu = { installed: false, downloading: `${layer}${detail}` };
        const now = Date.now();
        if (now - lastNotify > 500) {
          lastNotify = now;
          this.notify();
        }
      },
    })
      .then(() => {
        this.exl3xpu = { installed: true };
      })
      .catch((error: unknown) => {
        this.exl3xpu = {
          installed: false,
          error: `Could not download the exl3xpu engine: ${errorMessage(error)}`,
        };
      })
      .finally(() => this.notify());
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
