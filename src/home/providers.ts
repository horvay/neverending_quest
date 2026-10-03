import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import {
  installLocalEngine,
  installLocalExl3xpu,
  listInstalledLocalModels,
  localExl3xpuInstalled,
  listLocalGpus,
  listLocalMmproj,
  type LocalInferenceHostClient,
} from "@nq/local-inference/host.ts";
import { createLocalRuntimeManager } from "@nq/local-inference/runtime.ts";
import type { LocalCacheType } from "@nq/local-inference/profile.ts";
import { resolveAutoTuning, type AlmanacEntry } from "@nq/local-inference/almanac.ts";
import type { HomeProvider, LocalEngineOptions } from "./types.ts";

export const LOCAL_PROVIDER_ID = "llama.cpp";
export const DEFAULT_LOCAL_URL = "http://127.0.0.1:8080";
export {
  installLocalEngine,
  installLocalExl3xpu,
  listLocalGpus,
  listLocalMmproj,
  localExl3xpuInstalled,
};

/**
 * Home's `prepareModel` for `nq serve`: lease the Local Inference Host for a
 * `llama.cpp/<alias>` Game Master with the whole engine profile, or release it
 * for any other model. A field left out here launches the engine on its
 * default, so the next warm with the full profile would reload the model.
 *
 * `tuning` holds only the player's own values. Auto fills the rest from the
 * Almanac entry that recognises the model, for the thinking level it will
 * run at, so every caller (Home, `nq turn`) launches the same engine.
 */
export async function prepareLocalGameMaster(
  host: LocalInferenceHostClient,
  model: string | undefined,
  opts: {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    /** The thinking level the Game Master will play at. */
    reasoning?: string;
    /** The player's own Almanac entries. */
    almanac?: readonly AlmanacEntry[];
  } & Partial<LocalEngineOptions> = {},
): Promise<void> {
  if (!model?.startsWith(`${LOCAL_PROVIDER_ID}/`)) {
    await host.deactivate();
    return;
  }
  opts.onProgress?.("Warming the Game Master…");
  const alias = model.slice(`${LOCAL_PROVIDER_ID}/`.length);
  const installed = (await listInstalledLocalModels(host.rootDir)).find(
    (entry) => entry.id === alias,
  );
  const tuning = installed
    ? resolveAutoTuning({
        identity: installed.identity,
        yours: opts.almanac ?? [],
        reasoning: opts.reasoning,
        modelFile: installed.sampling,
        overrides: opts.tuning,
      }).tuning
    : opts.tuning;
  await host.activate(
    {
      model: alias,
      ...(opts.contextTokens !== undefined
        ? { contextTokens: opts.contextTokens }
        : {}),
      ...(opts.reasoningTokens !== undefined
        ? { reasoningTokens: opts.reasoningTokens }
        : {}),
      ...(opts.cacheK ? { cacheK: opts.cacheK as LocalCacheType } : {}),
      ...(opts.cacheV ? { cacheV: opts.cacheV as LocalCacheType } : {}),
      ...(tuning ? { tuning } : {}),
      ...(opts.kvOffload !== undefined ? { kvOffload: opts.kvOffload } : {}),
      ...(opts.flashAttention !== undefined
        ? { flashAttention: opts.flashAttention }
        : {}),
      ...(opts.gpu ? { gpu: opts.gpu } : {}),
      ...(opts.parallel !== undefined ? { parallel: opts.parallel } : {}),
      ...(opts.ramCacheGiB !== undefined ? { ramCacheGiB: opts.ramCacheGiB } : {}),
    },
    opts.signal ? { signal: opts.signal } : {},
  );
}

/** Attaches a projector to a local model, or clears it when `file` is empty. */
export async function setLocalMmproj(alias: string, file?: string): Promise<void> {
  await createLocalRuntimeManager().setModelMmproj(alias, file);
}

const FEATURED_IDS = ["xai-oauth", "anthropic", "openai-codex"] as const;

const DISPLAY_BY_ID: Readonly<Record<string, string>> = {
  "xai-oauth": "Grok",
  anthropic: "Claude",
  "openai-codex": "ChatGPT",
  "openai-codex-device": "ChatGPT (this device)",
  [LOCAL_PROVIDER_ID]: "This computer",
};

const MODEL_PROVIDER_BY_LOGIN: Readonly<Record<string, string>> = {
  "openai-codex-device": "openai-codex",
};

export function providerDisplayName(id: string, fallback?: string): string {
  if (DISPLAY_BY_ID[id]) return DISPLAY_BY_ID[id]!;
  return cleanProviderLabel(fallback ?? id);
}

export function modelProviderId(loginProviderId: string): string {
  return MODEL_PROVIDER_BY_LOGIN[loginProviderId] ?? loginProviderId;
}

export function resolveProviderId(
  raw: string,
  providers: HomeProvider[],
): string | undefined {
  const needle = raw.trim().toLowerCase();
  if (!needle) return undefined;
  const exact = providers.find((p) => p.id === raw || p.id.toLowerCase() === needle);
  if (exact) return exact.id;
  const byName = providers.find((p) => p.name.toLowerCase() === needle);
  if (byName) return byName.id;
  if (needle === "grok") return "xai-oauth";
  if (needle === "claude") return "anthropic";
  if (needle === "chatgpt") return "openai-codex";
  if (needle === "this computer" || needle === "this-computer") {
    return LOCAL_PROVIDER_ID;
  }
  return undefined;
}

export function splitProviderRow(
  providers: HomeProvider[],
  localAvailable: boolean,
): { featured: HomeProvider[]; more: HomeProvider[] } {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const featured: HomeProvider[] = [];
  for (const id of FEATURED_IDS) {
    const found = byId.get(id);
    if (found) {
      featured.push({
        id: found.id,
        name: providerDisplayName(found.id, found.name),
        connected: found.connected,
      });
    }
  }
  if (localAvailable) {
    featured.push({
      id: LOCAL_PROVIDER_ID,
      name: providerDisplayName(LOCAL_PROVIDER_ID),
      connected: true,
    });
  }
  const featuredIds = new Set(featured.map((p) => p.id));
  featuredIds.add(LOCAL_PROVIDER_ID);
  const more = providers
    .filter((p) => !featuredIds.has(p.id))
    .map((p) => ({
      id: p.id,
      name: providerDisplayName(p.id, p.name),
      connected: p.connected,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { featured, more };
}

export function listOauthProviders(): HomeProvider[] {
  return getOAuthProviders().map((p) => ({
    id: String(p.id),
    name: providerDisplayName(String(p.id), p.name),
  }));
}

export async function listOauthProvidersWithAuth(
  storage?: AuthStorage,
): Promise<HomeProvider[]> {
  const store = storage ?? (await discoverAuthStorage());
  try {
    await store.reload();
    return getOAuthProviders().map((p) => {
      const id = String(p.id);
      const storeAs = modelProviderId(id);
      return {
        id,
        name: providerDisplayName(id, p.name),
        connected: store.hasAuth(id) || store.hasAuth(storeAs),
      };
    });
  } finally {
    // a caller's store is theirs to close
    if (!storage) store.close();
  }
}

export async function probeLocalInstallation(): Promise<boolean> {
  return (await listInstalledLocalModels()).length > 0;
}

export async function listLocalModels(): ReturnType<
  typeof listInstalledLocalModels
> {
  return listInstalledLocalModels();
}

function cleanProviderLabel(raw: string): string {
  return raw
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\bOAuth\b/gi, "")
    .replace(/\bAPI\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || raw;
}
