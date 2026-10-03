/**
 * Per-model engine profiles for "This computer": where each local model runs
 * and how its engine is launched. A profile is saved when the player loads the
 * model; a model without one gets a default from its format and size.
 *
 * Profiles live beside the config file as plain JSON, like the Almanac.
 * Sampling is not part of a profile: the Almanac and the load page's own
 * values already follow each model.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NqConfig } from "../config.ts";
import {
  normalizeLocalEngineProfile,
  parseLocalEngineProfile,
  type LocalEngineSettings,
  type LocalGpu,
  type LocalGpuChoice,
} from "@nq/local-inference/profile.ts";

/**
 * A model's saved engine settings: the package's profile without the model
 * and its sampling. `gpu` is null rather than absent, so "let the engine
 * choose" survives the trip through JSON to the load page.
 */
export type LocalEngineProfile = Omit<LocalEngineSettings, "gpu"> & {
  gpu: LocalGpuChoice | null;
};

/** What the load page hands in; the caches are checked here, not trusted. */
export type LocalEngineProfileDraft = Omit<LocalEngineProfile, "cacheK" | "cacheV"> & {
  cacheK: string;
  cacheV: string;
};

/** Profiles by local model alias (the part after `llama.cpp/`). */
export type LocalProfiles = Record<string, LocalEngineProfile>;

export function localProfilesPath(configPath: string): string {
  return path.join(path.dirname(configPath), "local_profiles.json");
}

export async function loadLocalProfiles(configPath: string): Promise<LocalProfiles> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(localProfilesPath(configPath), "utf8"));
  } catch {
    // missing, or a hand edit broke the JSON: defaults still load every model
    return {};
  }
  const models =
    raw && typeof raw === "object" && "models" in raw
      ? (raw as { models: unknown }).models
      : undefined;
  if (!models || typeof models !== "object") return {};
  const profiles: LocalProfiles = {};
  for (const [alias, value] of Object.entries(models as Record<string, unknown>)) {
    const profile = parseProfile(value);
    if (profile) profiles[alias] = profile;
  }
  return profiles;
}

export async function saveLocalProfile(
  configPath: string,
  alias: string,
  draft: LocalEngineProfileDraft,
): Promise<void> {
  const profile = parseProfile(draft);
  if (!profile) throw new Error(`Invalid engine profile for ${alias}.`);
  const profiles = { ...(await loadLocalProfiles(configPath)), [alias]: profile };
  const target = localProfilesPath(configPath);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ schema: 1, models: profiles }, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

/**
 * A saved profile, read with the package's profile parser. One that does not
 * name its sizes and caches is a broken hand edit, and the model falls back to
 * its default profile.
 */
function parseProfile(value: unknown): LocalEngineProfile | undefined {
  const parsed = parseLocalEngineProfile(value);
  if (
    parsed.contextTokens === undefined ||
    parsed.reasoningTokens === undefined ||
    parsed.cacheK === undefined ||
    parsed.cacheV === undefined
  ) {
    return undefined;
  }
  const {
    model: _model,
    tuning: _tuning,
    mmproj: _mmproj,
    gpu,
    ...settings
  } = normalizeLocalEngineProfile(parsed);
  return { ...settings, gpu: gpu ?? null };
}

/** The global [local] settings, which seed every default profile. */
export function profileFromConfig(config: NqConfig): LocalEngineProfile {
  return {
    contextTokens: config.localContextTokens,
    reasoningTokens: config.localReasoningTokens,
    cacheK: config.localCacheK,
    cacheV: config.localCacheV,
    kvOffload: config.localKvOffload,
    flashAttention: config.localFlashAttention,
    gpu: config.localGpu ?? null,
    parallel: 1,
    ramCacheGiB: 0,
  };
}

/** Headroom beyond the weights for the KV cache and compute buffers at a typical context. */
const FIT_OVERHEAD_MIB = 2048;

/**
 * Where a model runs when the player has not said: an EXL3 folder on exl3xpu
 * (which picks the Intel card itself); a GGUF on the installed engine's own
 * card when it fits there, else on the largest card that holds it (the Arc
 * through Vulkan, with flash attention off), else back on the installed
 * engine, which spills layers to RAM.
 */
export function defaultLocalProfile(opts: {
  base: LocalEngineProfile;
  model: { size?: number; engine?: "exl3xpu" };
  gpus: readonly LocalGpu[];
  /** the backend `nq local install` chose; its cards are the default's first choice */
  primaryBackend?: string;
}): LocalEngineProfile {
  const automatic = { ...opts.base, gpu: null, flashAttention: true };
  if (opts.model.engine === "exl3xpu" || opts.model.size === undefined) return automatic;
  const needMiB = (opts.model.size / 2 ** 20) * 1.05 + FIT_OVERHEAD_MIB;
  const fits = (gpu: LocalGpu) => (gpu.memoryMiB ?? 0) >= needMiB;
  const primary = opts.gpus.filter((gpu) => gpu.backend === opts.primaryBackend);
  if (primary.some(fits)) return automatic;
  const largest = [...opts.gpus]
    .filter(fits)
    .sort((left, right) => (right.memoryMiB ?? 0) - (left.memoryMiB ?? 0))[0];
  if (!largest) return automatic;
  const intelVulkan = largest.backend === "vulkan" && /\bIntel\b/i.test(largest.name);
  return {
    ...opts.base,
    gpu: { backend: largest.backend, device: largest.device, name: largest.name },
    // Intel's Vulkan driver lacks the matrix tiles flash attention needs
    flashAttention: !intelVulkan,
  };
}

/**
 * The profile a model loads with, and whether the player saved it. The model
 * the config already names keeps the global settings it was chosen with, so
 * moving to per-model profiles changes nothing for it.
 */
export function resolveLocalProfile(opts: {
  alias: string;
  profiles: LocalProfiles;
  config: NqConfig;
  model: { size?: number; engine?: "exl3xpu" };
  gpus: readonly LocalGpu[];
  primaryBackend?: string;
}): { profile: LocalEngineProfile; saved: boolean } {
  const saved = opts.profiles[opts.alias];
  if (saved) return { profile: saved, saved: true };
  const base = profileFromConfig(opts.config);
  if (opts.config.model === `llama.cpp/${opts.alias}`) return { profile: base, saved: false };
  return {
    profile: defaultLocalProfile({
      base,
      model: opts.model,
      gpus: opts.gpus,
      ...(opts.primaryBackend ? { primaryBackend: opts.primaryBackend } : {}),
    }),
    saved: false,
  };
}
