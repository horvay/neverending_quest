/**
 * Typed calls to the book's HTTP routes (../api.ts). Each resolves to a
 * Reply rather than throwing: status 0 means the server could not be reached,
 * and a failure carries the server's player-facing words when it sent some.
 */
import {
  dossierArchivePath,
  inspectPath,
  ROUTES,
  type AlmanacSaved,
  type AlmanacView,
  type ApiError,
  type CampaignOpened,
  type DossierArchived,
  type DossierCreated,
  type HistoryResponse,
  type HomeSettingsRequest,
  type HomeView,
  type IllustrationStarted,
  type IllustrationStatus,
  type InspectLeaf,
  type InspectStale,
  type LocalLogQuery,
  type LocalLogResponse,
  type LoginLocalRequest,
  type LuckResponse,
  type ScratchResponse,
} from "../api.ts";
import type { AlmanacEntry } from "@nq/local-inference/almanac.ts";
import type { ManualHygieneMode } from "../../../play/types.ts";

export type Reply<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; error?: string; body?: unknown };

type Init = {
  method?: "GET" | "POST" | "PUT";
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Parse the success body as JSON (default) or ignore it. */
  read?: "json" | "none";
};

async function call<T>(path: string, init: Init = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...init.headers };
  let body: string | undefined;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.text !== undefined) {
    body = init.text;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      ...(body !== undefined ? { body } : {}),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!res.ok) {
    const failure = (await res.json().catch(() => undefined)) as unknown;
    const error = (failure as ApiError | undefined)?.error;
    return {
      ok: false,
      status: res.status,
      ...(typeof error === "string" && error.trim() ? { error } : {}),
      ...(failure !== undefined ? { body: failure } : {}),
    };
  }
  if (init.read === "none" || res.status === 204 || res.status === 202) {
    return { ok: true, status: res.status, body: undefined as T };
  }
  try {
    return { ok: true, status: res.status, body: (await res.json()) as T };
  } catch {
    return { ok: false, status: res.status };
  }
}

const post = <T = void>(path: string, json?: unknown, read: Init["read"] = "json") =>
  call<T>(path, { method: "POST", ...(json !== undefined ? { json } : {}), read });

export const api = {
  // play
  events: (signal: AbortSignal) => fetch(ROUTES.events, { signal }),
  history: () => call<HistoryResponse>(ROUTES.history),
  scratch: () => call<ScratchResponse>(ROUTES.scratch),
  localLog: (query: LocalLogQuery) => {
    const params = new URLSearchParams({ source: query.source });
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    if (query.file) params.set("file", query.file);
    return call<LocalLogResponse>(`${ROUTES.localLog}?${params}`);
  },
  turn: (text: string) => post(ROUTES.turn, { text }, "none"),
  luck: (armed: boolean) => post<LuckResponse>(ROUTES.luck, { armed }),
  interrupt: () => post(ROUTES.interrupt, undefined, "none"),
  endReasoning: () => post(ROUTES.endReasoning, undefined, "none"),
  editTranscript: (ts: string, text: string) =>
    post(ROUTES.transcriptEdit, { ts, text }, "none"),
  deleteTranscript: (ts?: string) =>
    post(ROUTES.transcriptDelete, ts ? { ts } : {}, "none"),
  retry: (ts: string, thinking?: string) =>
    post(ROUTES.retry, thinking === undefined ? { ts } : { ts, thinking }, "none"),
  continueFrom: (turn: number) => post(ROUTES.continue, { turn }, "none"),
  hygiene: (mode: ManualHygieneMode) => post(ROUTES.hygiene, { mode }, "none"),
  inspect: (target: string, slug?: string) => call<InspectLeaf>(inspectPath(target, slug)),
  /** 409 with an InspectStale body: the file changed on disk first. */
  saveInspect: (target: string, slug: string | undefined, text: string, hash: string) =>
    call<void>(inspectPath(target, slug), {
      method: "PUT",
      text,
      headers: { "If-Match": hash },
      read: "none",
    }),
  createDossier: (slug: string) => post<DossierCreated>(ROUTES.dossiers, { slug }),
  archiveDossier: (slug: string, archive: boolean) =>
    post<DossierArchived>(dossierArchivePath(slug), { archive }),
  illustrationStatus: () => call<IllustrationStatus>(ROUTES.illustration),
  illustrate: (prompt?: string) =>
    post<IllustrationStarted>(ROUTES.illustration, prompt ? { prompt } : undefined),
  pickIllustration: (slot: number) =>
    post<IllustrationStarted>(ROUTES.illustrationPick, { slot }),
  cancelIllustration: () => post(ROUTES.illustrationCancel, undefined, "none"),

  // Home
  home: () => call<HomeView>(ROUTES.home),
  login: (provider: string) => post<HomeView>(ROUTES.login, { provider }),
  loginCancel: () => post<HomeView>(ROUTES.loginCancel),
  loginModel: (model: string) => post<HomeView>(ROUTES.loginModel, { model }),
  loginReasoning: (reasoning: string) =>
    post<HomeView>(ROUTES.loginReasoning, { reasoning }),
  loginLocal: (local: LoginLocalRequest) => post<HomeView>(ROUTES.loginLocal, local),
  loginPrompt: (text: string) => post<HomeView>(ROUTES.loginPrompt, { text }),
  loginEngine: (backend: string) => post<HomeView>(ROUTES.loginEngine, { backend }),
  birth: (pack: string, title?: string) =>
    post<CampaignOpened>(ROUTES.campaigns, { pack, ...(title ? { title } : {}) }),
  openCampaign: (id: string) => post<CampaignOpened>(ROUTES.campaignsOpen, { id }),
  deleteCampaign: (id: string) => post(ROUTES.campaignsDelete, { id }, "none"),
  settings: (settings: HomeSettingsRequest) => post<HomeView>(ROUTES.settings, settings),
  playSettings: (settings: HomeSettingsRequest) =>
    post<HomeView>(ROUTES.playSettings, settings),
  leave: () => post(ROUTES.leave, undefined, "none"),
  warmModel: () => post(ROUTES.modelWarm, undefined, "none"),
  almanac: () => call<AlmanacView>(ROUTES.almanac),
  saveAlmanacEntry: (entry: Partial<AlmanacEntry>) =>
    post<AlmanacSaved>(ROUTES.almanac, entry),
  deleteAlmanacEntry: (id: string) => post<AlmanacView>(ROUTES.almanacDelete, { id }),
};

export function isStale(body: unknown): body is InspectStale {
  return Boolean(body && typeof (body as InspectStale).text === "string");
}
