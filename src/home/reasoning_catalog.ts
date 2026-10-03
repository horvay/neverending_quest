import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { discoverAuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";

export type ReasoningChoice = {
  id: string;
  name: string;
};

export type ReasoningCatalog = {
  choicesFor: (selector: string) => Promise<ReasoningChoice[]>;
};

export type OmpThinkingModel = {
  reasoning?: boolean;
  thinking?: { efforts?: readonly string[] };
};

export const emptyReasoningCatalog: ReasoningCatalog = {
  choicesFor: async () => [],
};

const EFFORT_NAMES: Record<string, string> = {
  off: "Off",
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const PROVIDER_SIBLINGS: Record<string, string[]> = {
  "xai-oauth": ["xai"],
  xai: ["xai-oauth"],
  "openai-codex": ["openai"],
  openai: ["openai-codex"],
};

const MODELS_DEV_API = "https://models.dev/api.json";

const MODELS_DEV_PROVIDER_ALIASES: Record<string, string> = {
  "xai-oauth": "xai",
  xai: "xai",
  "openai-codex": "openai",
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  "google-gemini-cli": "google",
  "google-vertex": "google",
  kimi: "moonshotai",
  moonshot: "moonshotai",
  moonshotai: "moonshotai",
};

type ModelsDevEntry = {
  efforts: string[];
};

type ModelsDevCatalog = {
  byProvider: Map<string, Map<string, ModelsDevEntry>>;
};

export function displayReasoningName(id: string): string {
  return EFFORT_NAMES[id] ?? id;
}

export function choicesFromOmpModel(
  model: OmpThinkingModel | undefined,
): ReasoningChoice[] {
  if (!model?.reasoning) return [];
  const efforts = getSupportedEfforts({
    reasoning: model.reasoning,
    thinking: model.thinking,
  } as Parameters<typeof getSupportedEfforts>[0]);
  const ids: string[] = [];
  for (const effort of efforts) {
    const id = normalizeEffort(String(effort));
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => ({ id, name: displayReasoningName(id) }));
}

export function lookupBundledOmpModel(
  selector: string,
): OmpThinkingModel | undefined {
  const { provider, id } = splitSelector(selector);
  if (!id) return undefined;
  for (const candidate of providerCandidates(provider)) {
    try {
      const model = getBundledModel(
        candidate as Parameters<typeof getBundledModel>[0],
        id,
      );
      if (model) return model;
    } catch {
      // unknown provider id in the bundled table
    }
  }
  return undefined;
}

export function createOmpReasoningCatalog(opts?: {
  lookup?: (selector: string) => Promise<OmpThinkingModel | undefined>;
  modelsDev?: ModelsDevSource;
}): ReasoningCatalog {
  const lookup = opts?.lookup ?? defaultOmpLookup;
  const modelsDev = opts?.modelsDev ?? createModelsDevSource();
  return {
    async choicesFor(selector) {
      const fromOmp = choicesFromOmpModel(await lookup(selector));
      if (fromOmp.length > 0) return fromOmp;
      return modelsDev.choicesFor(selector);
    },
  };
}

export type CatalogFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

export type ModelsDevSource = {
  choicesFor: (selector: string) => Promise<ReasoningChoice[]>;
};

export function parseModelsDevApi(raw: unknown): ModelsDevCatalog {
  const byProvider = new Map<string, Map<string, ModelsDevEntry>>();
  if (!raw || typeof raw !== "object") return { byProvider };
  for (const [providerId, provider] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as { models?: unknown }).models;
    if (!models || typeof models !== "object") continue;
    const map = new Map<string, ModelsDevEntry>();
    for (const [modelKey, model] of Object.entries(
      models as Record<string, unknown>,
    )) {
      const parsed = parseModelsDevModel(model);
      if (!parsed) continue;
      map.set(normalizeModelsDevId(modelKey), parsed);
      const listedId =
        model && typeof model === "object" && "id" in model
          ? String((model as { id?: unknown }).id ?? "")
          : "";
      if (listedId) map.set(normalizeModelsDevId(listedId), parsed);
    }
    if (map.size > 0) byProvider.set(providerId.toLowerCase(), map);
  }
  return { byProvider };
}

export function choicesFromModelsDev(
  catalog: ModelsDevCatalog,
  selector: string,
): ReasoningChoice[] {
  const { provider, id } = splitSelector(selector);
  const modelId = normalizeModelsDevId(id);
  if (!modelId) return [];
  const mapped = MODELS_DEV_PROVIDER_ALIASES[provider] ?? provider;
  const direct = catalog.byProvider.get(mapped)?.get(modelId);
  if (direct && direct.efforts.length > 0) return toChoices(direct.efforts);
  let fallback: ModelsDevEntry | undefined;
  for (const models of catalog.byProvider.values()) {
    const hit = models.get(modelId);
    if (!hit) continue;
    if (hit.efforts.length > 0) return toChoices(hit.efforts);
    fallback ??= hit;
  }
  return fallback ? toChoices(fallback.efforts) : [];
}

export function createModelsDevSource(opts?: {
  fetch?: CatalogFetch;
  url?: string;
}): ModelsDevSource {
  let loaded: Promise<ModelsDevCatalog> | undefined;
  const load = () => {
    if (!loaded) {
      loaded = fetchModelsDev(opts).catch(() => parseModelsDevApi({}));
    }
    return loaded;
  };
  return {
    async choicesFor(selector) {
      return choicesFromModelsDev(await load(), selector);
    },
  };
}

async function defaultOmpLookup(
  selector: string,
): Promise<OmpThinkingModel | undefined> {
  const bundled = lookupBundledOmpModel(selector);
  if (bundled) return bundled;
  return findLiveOmpModel(selector);
}

async function findLiveOmpModel(
  selector: string,
): Promise<OmpThinkingModel | undefined> {
  const { provider, id } = splitSelector(selector);
  if (!provider || !id) return undefined;
  let storage: AuthStorage | undefined;
  try {
    storage = await discoverAuthStorage();
    await storage.reload();
    const registry = new ModelRegistry(storage);
    await registry.refreshProvider(provider, "online");
    return (
      registry.find(provider, id) ??
      registry.getAvailable().find((m) => m.provider === provider && m.id === id)
    );
  } catch {
    return undefined;
  } finally {
    storage?.close();
  }
}

function providerCandidates(provider: string): string[] {
  return [provider, ...(PROVIDER_SIBLINGS[provider] ?? [])];
}

function splitSelector(selector: string): { provider: string; id: string } {
  const slash = selector.indexOf("/");
  if (slash < 0) return { provider: "", id: selector.trim() };
  return {
    provider: selector.slice(0, slash),
    id: selector.slice(slash + 1),
  };
}

function parseModelsDevModel(model: unknown): ModelsDevEntry | undefined {
  if (!model || typeof model !== "object") return undefined;
  const rec = model as { reasoning?: unknown; reasoning_options?: unknown };
  const options = Array.isArray(rec.reasoning_options)
    ? rec.reasoning_options
    : [];
  const efforts: string[] = [];
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const row = option as { type?: unknown; values?: unknown };
    if (row.type !== "effort" || !Array.isArray(row.values)) continue;
    for (const value of row.values) {
      if (typeof value !== "string") continue;
      const id = normalizeEffort(value);
      if (id && !efforts.includes(id)) efforts.push(id);
    }
  }
  if (efforts.length === 0) return undefined;
  return { efforts };
}

async function fetchModelsDev(opts?: {
  fetch?: CatalogFetch;
  url?: string;
}): Promise<ModelsDevCatalog> {
  const doFetch = opts?.fetch ?? globalThis.fetch;
  const url = opts?.url ?? MODELS_DEV_API;
  const res = await doFetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return parseModelsDevApi({});
  return parseModelsDevApi(await res.json());
}

function toChoices(efforts: string[]): ReasoningChoice[] {
  return efforts.map((id) => ({ id, name: displayReasoningName(id) }));
}

function normalizeModelsDevId(raw: string): string {
  const parts = raw.trim().toLowerCase().split("/");
  return parts[parts.length - 1] ?? "";
}

function normalizeEffort(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "none") return "off";
  return value in EFFORT_NAMES ? value : undefined;
}
