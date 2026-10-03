import type { HomeSettings } from "./settings.ts";
import type { LocalTuning } from "@nq/local-inference/tuning.ts";
import type { ModelIdentity } from "@nq/local-inference/almanac.ts";
import type { LocalGpuChoice, LocalGpuList } from "@nq/local-inference/profile.ts";
import type { LocalEngineProfile } from "./local_profiles.ts";

export type HomeProvider = {
  id: string;
  name: string;
  connected?: boolean;
};

export type HomeModel = {
  selector: string;
  name: string;
  /** Projector currently attached to this model, if any. */
  mmproj?: string;
  reasoning?: Array<{ id: string; name: string }>;
  size?: number;
  /** A local model's own sampling recommendations, shown for unset knobs. */
  sampling?: LocalTuning;
  /** Set for EXL3 models, which run on the exl3xpu engine. */
  engine?: "exl3xpu";
  /** What the Almanac recognises a local model by. */
  identity?: ModelIdentity;
};
export type HomeMmproj = {
  /** Absolute path, used as the select value. */
  path: string;
  name: string;
  size?: number;
};
/**
 * Everything that decides how Atomic is launched. Changing any of it restarts
 * the engine, so the whole shape travels together from the picker to the host.
 */
export type LocalEngineOptions = {
  contextTokens: number;
  reasoningTokens: number;
  cacheK?: string;
  cacheV?: string;
  /** sampling and fit knobs; unset knobs fall back to Atomic's defaults */
  tuning?: LocalTuning;
  /** false keeps the KV cache in system RAM instead of on the card */
  kvOffload?: boolean;
  /** false runs attention without flash attention, on f16 caches */
  flashAttention?: boolean;
  /** the one card to run on; unset lets the engine use every card it sees */
  gpu?: LocalGpuChoice;
  /** games the engine serves at once (exl3xpu only); default 1 */
  parallel?: number;
  /** GiB of system RAM that keeps idle games' KV cache (exl3xpu only); default 0 */
  ramCacheGiB?: number;
};

export type LocalModelSelection = LocalEngineOptions & {
  model: string;
  /** Projector to load with the model; "" clears any existing one. */
  mmproj?: string;
  reasoning: string;
};

export type HomeExl3xpu = {
  installed: boolean;
  /** Progress of a download in flight. */
  downloading?: string;
  /** Why the last download failed. */
  error?: string;
};

export type SeedPackCard = {
  id: string;
  dir: string;
  name: string;
  description?: string;
};

export type CampaignCard = {
  id: string;
  name: string;
  path: string;
};

export type HomeLoginPhase =
  | "idle"
  | "working"
  | "awaiting_browser"
  | "awaiting_prompt"
  | "awaiting_model"
  | "awaiting_reasoning"
  | "awaiting_local"
  | "error";

export type HomeLoginState = {
  phase: HomeLoginPhase;
  message?: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type HomeSignedIn = {
  providerId: string;
  provider: string;
  modelSelector?: string;
  model?: string;
  reasoning?: string;
};

export type HomeOpenCampaign = {
  id: string;
  name: string;
  path: string;
};

export type HomeSnapshot = {
  signedIn: HomeSignedIn | null;
  locked: boolean;
  login: HomeLoginState;
  providers: {
    featured: HomeProvider[];
    more: HomeProvider[];
  };
  models: HomeModel[] | null;
  /** Projector files offered for a local model; null when not applicable. */
  mmproj: HomeMmproj[] | null;
  /** Cards the local engine can run on; null when not applicable. */
  gpus: LocalGpuList | null;
  /** The exl3xpu engine, when an EXL3 model is installed; null otherwise. */
  exl3xpu: HomeExl3xpu | null;
  /**
   * Each local model's engine profile by selector: the one the player saved
   * when loading it, or a default from its format and size. Null off "This computer".
   */
  localProfiles: Record<string, { profile: LocalEngineProfile; saved: boolean }> | null;
  reasoning: Array<{ id: string; name: string }> | null;
  campaigns: CampaignCard[];
  packs: SeedPackCard[];
  settings: HomeSettings;
  /** Setting keys this surface fixes; the player cannot change them. */
  fixedSettings: Array<keyof HomeSettings>;
  /** False where debug logging, log files and the AI log are unavailable. */
  diagnostics: boolean;
  /** False on a book with one fixed Game Master: no sign-in, no Model choice. */
  choosesGameMaster: boolean;
  open: HomeOpenCampaign | null;
};

export type LoginPrompt = {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type LoginAuthInfo = {
  url?: string;
  launchUrl?: string;
  instructions?: string;
};

export type LoginHooks = {
  onAuth: (info: LoginAuthInfo) => void;
  onPrompt: (prompt: LoginPrompt) => Promise<string>;
  onProgress: (message: string) => void;
  onManualCodeInput: () => Promise<string>;
  signal: AbortSignal;
};

export type HomeAuth = {
  listProviders: () => Promise<HomeProvider[]>;
  login: (providerId: string, hooks: LoginHooks) => Promise<void>;
  listModels: (providerId: string) => Promise<HomeModel[]>;
};

export const PLAYER_FAILURE = {
  browser: "A browser window should have opened. If it did not, try again.",
  cancelled: "Sign-in was cancelled.",
  failed: "Could not sign in. Try again.",
  noModels: "No models are available for this Provider.",
  needSignIn: "Sign in before starting an adventure.",
  localMissing: "A local Game Master is not installed.",
  modelUnavailable:
    "Could not wake the Game Master. Check the Model and try again.",
  busy: "An adventure is already open.",
  locked: "Provider and Model stay the same for this sitting.",
  oneGameMaster: "This book has one Game Master.",
  unknownProvider: "That Provider is not available.",
  unknownPack: "That adventure is not available.",
  unknownCampaign: "That Campaign is not in your library.",
  deleteFailed: "Could not delete that Campaign from disk.",
  openFailed: "Could not open that adventure.",
} as const;
