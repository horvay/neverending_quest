/**
 * Choosing who the Game Master plays with: signing in to a Provider (the
 * browser, a pasted key or code), picking its Model and thinking level. A
 * finished choice goes to the host to warm and save; "This computer" hands
 * over to the load page (`awaiting_local`).
 */
import { HomeError } from "./errors.ts";
import type { LocalSetup } from "./local_setup.ts";
import {
  LOCAL_PROVIDER_ID,
  providerDisplayName,
  resolveProviderId,
} from "./providers.ts";
import type { ReasoningCatalog, ReasoningChoice } from "./reasoning_catalog.ts";
import type {
  HomeAuth,
  HomeLoginState,
  HomeModel,
  HomeSignedIn,
  LoginPrompt,
} from "./types.ts";
import { PLAYER_FAILURE } from "./types.ts";

type PromptWaiter = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
};

export type SignInHost = {
  auth: HomeAuth;
  probeLocal: () => Promise<boolean>;
  openBrowser?: (url: string) => Promise<void>;
  reasoningCatalog: ReasoningCatalog;
  local: LocalSetup;
  /** One fixed Game Master: there is nothing to sign in to. */
  fixed: boolean;
  /** Throws while a Campaign is open or Home is locked to its choice. */
  assertCanChoose: () => void;
  /** Warm and save the chosen Model; sets `signedIn` and the login state. */
  commit: (model: HomeModel, reasoning?: ReasoningChoice) => Promise<void>;
  /** Stop a Game Master warm-up in flight. */
  cancelWarm: () => void;
  notify: () => void;
};

export class ProviderSignIn {
  login: HomeLoginState = { phase: "idle" };
  signedIn: HomeSignedIn | null;
  /** The Provider being signed in to, until a Model is chosen. */
  pendingProviderId: string | null = null;
  models: HomeModel[] | null = null;
  pendingModel: HomeModel | null = null;
  reasoningChoices: ReasoningChoice[] | null = null;
  localAvailable = false;
  private loginAbort: AbortController | null = null;
  private promptWaiter: PromptWaiter | null = null;
  private loginPromise: Promise<void> | null = null;

  constructor(
    private readonly host: SignInHost,
    signedIn: HomeSignedIn | null,
  ) {
    this.signedIn = signedIn;
  }

  setLogin(next: HomeLoginState): void {
    this.login = next;
    this.host.notify();
  }

  async start(providerRaw: string): Promise<void> {
    if (this.host.fixed) throw new HomeError("locked", PLAYER_FAILURE.oneGameMaster);
    this.host.assertCanChoose();
    if (this.loginPromise) throw new HomeError("busy", PLAYER_FAILURE.busy);

    this.localAvailable = await this.host.probeLocal();
    const providers = await this.host.auth.listProviders();
    if (this.localAvailable) {
      const local = providers.find(
        (provider) => provider.id === LOCAL_PROVIDER_ID,
      );
      if (local) {
        local.connected = true;
      } else {
        providers.push({
          id: LOCAL_PROVIDER_ID,
          name: providerDisplayName(LOCAL_PROVIDER_ID),
          connected: true,
        });
      }
    }
    const providerId = resolveProviderId(providerRaw, providers);
    if (!providerId) {
      throw new HomeError("unknown_provider", PLAYER_FAILURE.unknownProvider);
    }
    if (providerId === LOCAL_PROVIDER_ID && !this.localAvailable) {
      throw new HomeError("unknown_provider", PLAYER_FAILURE.localMissing);
    }

    const already =
      providers.find((p) => p.id === providerId)?.connected === true;
    if (already) {
      await this.openConnectedProvider(providerId);
      return;
    }

    this.cancel();
    const abort = new AbortController();
    this.loginAbort = abort;
    this.pendingProviderId = providerId;
    this.models = null;
    this.setLogin({
      phase: "working",
      message:
        providerId === LOCAL_PROVIDER_ID
          ? "Connecting to this computer…"
          : "Opening sign-in…",
    });

    const hooks = {
      onAuth: (info: {
        url?: string;
        launchUrl?: string;
        instructions?: string;
      }) => {
        const launch = oauthLaunchUrl(providerId, info);
        if (launch && this.host.openBrowser) {
          void this.host.openBrowser(launch).catch(() => {
            this.setLogin({
              phase: "awaiting_browser",
              message: PLAYER_FAILURE.browser,
            });
          });
        }
        this.setLogin({
          phase: launch ? "awaiting_browser" : "working",
          message:
            info.instructions ||
            (launch
              ? "A browser window should have opened. Finish signing in there."
              : "Signing in…"),
        });
      },
      onPrompt: async (prompt: LoginPrompt) => {
        this.setLogin({
          phase: "awaiting_prompt",
          message: prompt.message,
          allowEmpty: prompt.allowEmpty,
        });
        return this.waitForPrompt(abort.signal);
      },
      onProgress: (message: string) => {
        if (this.login.phase === "awaiting_prompt") return;
        this.setLogin({
          phase:
            this.login.phase === "awaiting_browser"
              ? "awaiting_browser"
              : "working",
          message,
        });
      },
      onManualCodeInput: async () => {
        this.setLogin({
          phase: "awaiting_prompt",
          message: "Paste the code from the browser.",
        });
        return this.waitForPrompt(abort.signal);
      },
      signal: abort.signal,
    };

    const work = this.host.auth
      .login(providerId, hooks)
      .then(async () => {
        if (abort.signal.aborted) return;
        const models = await this.host.auth.listModels(providerId);
        this.models = models;
        await this.host.local.refresh(providerId, models);
        this.signedIn = {
          providerId,
          provider: providerDisplayName(providerId),
        };
        if (models.length === 1) {
          await this.pickModel(models[0]!.selector);
          return;
        }
        if (models.length === 0) {
          this.setLogin({ phase: "error", message: PLAYER_FAILURE.noModels });
          return;
        }
        this.setLogin({
          phase: "awaiting_model",
          message: "Choose a Model.",
        });
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) {
          this.setLogin({ phase: "idle" });
          return;
        }
        this.setLogin({
          phase: "error",
          message:
            err instanceof Error && /cancel/i.test(err.message)
              ? PLAYER_FAILURE.cancelled
              : PLAYER_FAILURE.failed,
        });
      })
      .finally(() => {
        if (this.loginAbort === abort) {
          this.loginAbort = null;
          this.loginPromise = null;
          this.promptWaiter = null;
        }
      });

    this.loginPromise = work;
  }

  private async openConnectedProvider(providerId: string): Promise<void> {
    this.pendingProviderId = providerId;
    this.models = null;
    this.setLogin({
      phase: "working",
      message: "Loading models…",
    });
    try {
      const models = await this.host.auth.listModels(providerId);
      this.models = models;
      await this.host.local.refresh(providerId, models);
      this.signedIn = {
        providerId,
        provider: providerDisplayName(providerId),
        modelSelector:
          this.signedIn?.providerId === providerId
            ? this.signedIn.modelSelector
            : undefined,
        model:
          this.signedIn?.providerId === providerId
            ? this.signedIn.model
            : undefined,
      };
      if (models.length === 0) {
        this.setLogin({ phase: "error", message: PLAYER_FAILURE.noModels });
        return;
      }
      if (providerId === LOCAL_PROVIDER_ID) {
        this.setLogin({
          phase: "awaiting_local",
          message: "Choose how this computer should run the Game Master.",
        });
        return;
      }
      if (models.length === 1) {
        await this.pickModel(models[0]!.selector);
        return;
      }
      this.setLogin({
        phase: "awaiting_model",
        message: "Choose a Model.",
      });
    } catch {
      this.setLogin({ phase: "error", message: PLAYER_FAILURE.noModels });
    }
  }

  async completePrompt(text: string): Promise<void> {
    if (this.login.phase === "awaiting_model") {
      await this.pickModel(text);
      return;
    }
    if (this.login.phase === "awaiting_reasoning") {
      await this.pickReasoning(text);
      return;
    }
    if (!this.promptWaiter) {
      throw new HomeError("login", "Nothing is waiting for input.");
    }
    const waiter = this.promptWaiter;
    this.promptWaiter = null;
    this.setLogin({ phase: "working", message: "Signing in…" });
    waiter.resolve(text);
    if (this.loginPromise) await this.loginPromise;
  }

  cancel(): void {
    this.host.cancelWarm();
    this.loginAbort?.abort();
    this.loginAbort = null;
    if (this.promptWaiter) {
      this.promptWaiter.reject(new Error("cancelled"));
      this.promptWaiter = null;
    }
    this.loginPromise = null;
    this.pendingModel = null;
    this.reasoningChoices = null;
    if (this.login.phase !== "idle") {
      this.setLogin({ phase: "idle" });
    }
  }

  async pickModel(raw: string): Promise<void> {
    this.host.assertCanChoose();
    const models = this.models ?? [];
    const needle = raw.trim();
    const chosen =
      models.find((m) => m.name.toLowerCase() === needle.toLowerCase()) ??
      models.find((m) => m.selector === needle);
    if (!chosen) {
      throw new HomeError("login", PLAYER_FAILURE.noModels);
    }
    this.pendingModel = chosen;
    const choices =
      chosen.reasoning && chosen.reasoning.length > 0
        ? chosen.reasoning
        : await this.host.reasoningCatalog.choicesFor(chosen.selector);
    if (choices.length <= 1) {
      await this.host.commit(chosen, choices[0]);
      return;
    }
    this.reasoningChoices = choices;
    this.setLogin({
      phase: "awaiting_reasoning",
      message: "How hard should it think?",
    });
  }

  async pickReasoning(raw: string): Promise<void> {
    this.host.assertCanChoose();
    const chosen = this.pendingModel;
    const choices = this.reasoningChoices ?? [];
    if (!chosen || choices.length === 0) {
      throw new HomeError("login", PLAYER_FAILURE.noModels);
    }
    const needle = raw.trim();
    const level =
      choices.find((c) => c.name.toLowerCase() === needle.toLowerCase()) ??
      choices.find((c) => c.id === needle.toLowerCase());
    if (!level) {
      throw new HomeError("login", "That thinking level is not available.");
    }
    await this.host.commit(chosen, level);
  }

  private waitForPrompt(signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        this.promptWaiter = null;
        reject(new Error("cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.promptWaiter = {
        resolve: (text) => {
          signal.removeEventListener("abort", onAbort);
          resolve(text);
        },
        reject: (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      };
    });
  }
}

function oauthLaunchUrl(
  providerId: string,
  info: { url?: string; launchUrl?: string },
): string | undefined {
  if (providerId === LOCAL_PROVIDER_ID) return undefined;
  return info.launchUrl || info.url;
}
