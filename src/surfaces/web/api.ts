/**
 * The book's HTTP contract: every route the web client calls, with the shape
 * of what it sends and what comes back. `nq serve` (http.ts, http_home.ts) and
 * the hosted book's in-page handler answer these routes; the client calls them
 * through client/api.ts. Paths and types only, so the browser bundle can take
 * it without pulling in the server.
 */
import type { InspectSaveResult } from "../../campaign/inspect.ts";
import type { PlayState, ScratchRecord } from "../../campaign/types.ts";
import type { HomeAlmanac } from "../../home/surface.ts";
import type { HomeSettings } from "../../home/settings.ts";
import type { LocalModelSelection } from "../../home/types.ts";
import type { LocalEngineProfile } from "../../home/local_profiles.ts";
import type { KernelState } from "../../play/kernel.ts";
import type { InspectLeaf, ManualHygieneMode, PlayEvent } from "../../play/types.ts";
import type { AlmanacEntry, ModelIdentity } from "@nq/local-inference/almanac.ts";
import type { LocalLogChunk, LocalLogSource } from "@nq/local-inference/logs.ts";
import type { LocalGpuList } from "@nq/local-inference/profile.ts";
import type { LocalTuning } from "@nq/local-inference/tuning.ts";

export const ROUTES = {
  // play: the open Campaign
  /** NDJSON: one KernelState, then a PlayEvent per line. */
  events: "/api/events",
  history: "/api/history",
  scratch: "/api/scratch",
  localLog: "/api/local/log",
  turn: "/api/turn",
  luck: "/api/luck",
  interrupt: "/api/interrupt",
  endReasoning: "/api/reasoning/end",
  transcriptEdit: "/api/transcript/edit",
  transcriptDelete: "/api/transcript/delete",
  retry: "/api/retry",
  continue: "/api/continue",
  hygiene: "/api/hygiene",
  dossiers: "/api/inspect/dossiers",
  illustration: "/api/illustration",
  illustrationPick: "/api/illustration/pick",
  illustrationCancel: "/api/illustration/cancel",
  // Home
  home: "/api/home",
  login: "/api/login",
  loginCancel: "/api/login/cancel",
  loginModel: "/api/login/model",
  loginReasoning: "/api/login/reasoning",
  loginLocal: "/api/login/local",
  loginPrompt: "/api/login/prompt",
  loginEngine: "/api/login/engine",
  campaigns: "/api/campaigns",
  campaignsOpen: "/api/campaigns/open",
  campaignsDelete: "/api/campaigns/delete",
  settings: "/api/settings",
  playSettings: "/api/settings/play",
  leave: "/api/leave",
  modelWarm: "/api/model/warm",
  almanac: "/api/almanac",
  almanacDelete: "/api/almanac/delete",
} as const;

/** An Inspect leaf: `/api/inspect/<target>`, or one Dossier by slug. */
export function inspectPath(target: string, slug?: string): string {
  return slug ? `${ROUTES.dossiers}/${encodeURIComponent(slug)}` : `/api/inspect/${target}`;
}

export function dossierArchivePath(slug: string): string {
  return `${ROUTES.dossiers}/${encodeURIComponent(slug)}/archive`;
}

/** The kept picture of a Turn, or one candidate sitting while the easel is up. */
export function illustrationPath(ts: string, slot?: number): string {
  const base = `/api/illustrations/${encodeURIComponent(ts)}`;
  return slot === undefined ? base : `${base}?slot=${slot}`;
}

// play — request bodies
export type TurnRequest = { text: string };
export type LuckRequest = { armed: boolean };
export type TranscriptEditRequest = { ts: string; text: string };
export type TranscriptDeleteRequest = { ts?: string };
export type RetryRequest = { ts: string; thinking?: string };
export type ContinueRequest = { turn: number };
export type HygieneRequest = { mode: ManualHygieneMode };
export type DossierCreateRequest = { slug: string; body?: string };
export type DossierArchiveRequest = { archive?: boolean };
export type IllustrateRequest = { prompt?: string };
export type IllustrationPickRequest = { slot: number };
export type LocalLogQuery = { source: LocalLogSource; offset?: number; file?: string };

// play — responses
export type EventsHead = KernelState;
export type EventsLine = PlayEvent;
export type HistoryResponse = { entries: Array<{ turn: number; prose: string }> };
export type ScratchResponse = { records: ScratchRecord[] };
export type LuckResponse = PlayState;
export type { InspectLeaf };
/** 409 from an Inspect save: the file changed on disk; this is what it holds now. */
export type InspectStale = { text: string; hash: string };
export type DossierCreated = InspectSaveResult;
export type DossierArchived = { slug: string; archived: boolean; moved: boolean };
export type IllustrationStatus = { ready: boolean; reason?: string };
export type IllustrationStarted = { ts: string; prompt: string };
export type LocalLogResponse = LocalLogChunk;
/** The body of a failure that has player-facing words. */
export type ApiError = { error?: string; code?: string };

// Home — request bodies
export type LoginRequest = { provider: string };
export type LoginModelRequest = { model: string };
export type LoginReasoningRequest = { reasoning: string };
export type LoginLocalRequest = LocalModelSelection;
export type LoginPromptRequest = { text: string };
export type LoginEngineRequest = { backend: string };
export type CampaignBirthRequest = { pack: string; title?: string };
export type CampaignIdRequest = { id: string };
export type AlmanacDeleteRequest = { id: string };

// Home — responses
export type CampaignOpened = { id: string; name: string };
export type AlmanacView = HomeAlmanac;
export type AlmanacSaved = { entry: AlmanacEntry; almanac: AlmanacView };

/** What Home shows: never selectors' internals, paths, or OMP names. */
export type HomeView = {
  signedIn: { provider: string; model?: string } | null;
  locked: boolean;
  login: { phase: string; message?: string; allowEmpty?: boolean };
  providers: {
    featured: Array<{ name: string; connected: boolean }>;
    more: Array<{ name: string; connected: boolean }>;
  };
  models: Array<{
    name: string;
    selector?: string;
    size?: number;
    mmproj?: string;
    sampling?: LocalTuning;
    identity?: ModelIdentity;
    engine?: "exl3xpu";
  }> | null;
  mmproj: Array<{ path: string; name: string; size?: number }> | null;
  gpus: LocalGpuList | null;
  exl3xpu: { installed: boolean; downloading?: string; error?: string } | null;
  localProfiles: Record<string, { profile: LocalEngineProfile; saved: boolean }> | null;
  reasoning: Array<{ name: string }> | null;
  campaigns: Array<{ id: string; name: string }>;
  packs: Array<{ id: string; name: string; description?: string }>;
  settings: HomeSettings;
  /** Setting keys the player cannot change here; their fields are hidden. */
  fixedSettings: string[];
  diagnostics: boolean;
  /** False on a book with one fixed Game Master: no sign-in, no Model choice. */
  choosesGameMaster: boolean;
  open: { id: string; name: string } | null;
};

export type HomeSettingsRequest = Partial<HomeSettings>;
