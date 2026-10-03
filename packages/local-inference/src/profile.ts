/**
 * The engine profile: everything that decides how the local engine is
 * launched for the Game Master. Changing any of it restarts the engine, so
 * every place that carries a profile (the host's control API, the inference
 * state on disk, the runtime's start options, Home's saved per-model profiles)
 * reads, fills and compares it here, and nowhere else.
 *
 * - `parseLocalEngineProfile` reads untrusted JSON, keeping only valid fields;
 * - `normalizeLocalEngineProfile` fills every unset field with its default;
 * - `sameLocalEngineProfile` decides whether a running engine already serves
 *   a profile;
 * - `localStartOptions` hands the whole profile to the runtime's `start`.
 */
import type { LocalBackend } from "./target.ts";
import {
  parseLocalTuning,
  sameLocalTuning,
  type LocalTuning,
} from "./tuning.ts";

export const DEFAULT_LOCAL_CONTEXT_TOKENS = 65_536;
export const DEFAULT_LOCAL_REASONING_TOKENS = -1;

/** KV cache types Atomic accepts for -ctk / -ctv. */
export const LOCAL_CACHE_TYPES = [
  "f16",
  "q8_0",
  // Atomic Hadamard-rotates a q4_0 K cache and refits its scale, which puts it
  // near q8_0 quality at about half the size (ik_llama.cpp #1034, #1547).
  "q4_0",
  "turbo4",
  "turbo3",
  "turbo2",
] as const;
export type LocalCacheType = (typeof LOCAL_CACHE_TYPES)[number];

export function isLocalCacheType(value: unknown): value is LocalCacheType {
  return (
    typeof value === "string" &&
    (LOCAL_CACHE_TYPES as readonly string[]).includes(value)
  );
}
/** K stays 8-bit: on a high-GQA model a turbo K wrecks quality, and Atomic overrides it anyway. */
export const DEFAULT_LOCAL_CACHE_K: LocalCacheType = "q8_0";
/** V compresses well; turbo3 costs nothing measurable while the cache is in VRAM. */
export const DEFAULT_LOCAL_CACHE_V: LocalCacheType = "turbo3";

/** A card one Atomic build can run on, as its `--list-devices` reports it. */
export type LocalGpu = {
  backend: Exclude<LocalBackend, "auto">;
  /** Atomic's name for the card, passed as `--device`: CUDA0, Vulkan1, … */
  device: string;
  name: string;
  memoryMiB?: number;
};

export type LocalGpuChoice = Pick<LocalGpu, "backend" | "device" | "name">;

export type LocalGpuList = {
  gpus: LocalGpu[];
  /** The backend `nq local install` chose, whose cards are listed first. */
  primaryBackend?: Exclude<LocalBackend, "auto">;
  /** Builds this platform has that would show more cards once downloaded. */
  downloadable: Exclude<LocalBackend, "auto">[];
};

const LOCAL_BACKENDS = [
  "cpu",
  "vulkan",
  "cuda-12.4",
  "cuda-13.3",
  "rocm",
  "metal",
] as const;

export function sameLocalGpu(
  left: LocalGpuChoice | null | undefined,
  right: LocalGpuChoice | null | undefined,
): boolean {
  return (
    left?.backend === right?.backend &&
    left?.device === right?.device &&
    left?.name === right?.name
  );
}

export function parseLocalGpuChoice(value: unknown): LocalGpuChoice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.backend !== "string" ||
    !(LOCAL_BACKENDS as readonly string[]).includes(raw.backend) ||
    typeof raw.device !== "string" ||
    !raw.device.trim() ||
    typeof raw.name !== "string"
  ) {
    return undefined;
  }
  return {
    backend: raw.backend as LocalGpuChoice["backend"],
    device: raw.device.trim(),
    name: raw.name,
  };
}

/**
 * The engine knobs a profile sets for any model: what the load page shows
 * and saves per model.
 */
export type LocalEngineSettings = {
  contextTokens: number;
  /** Atomic's `--reasoning-budget`; -1 leaves thinking unbounded */
  reasoningTokens: number;
  cacheK: LocalCacheType;
  cacheV: LocalCacheType;
  /** false keeps the KV cache in system RAM instead of on the card */
  kvOffload: boolean;
  /**
   * false runs attention as plain matrix multiplies, with f16 caches. Faster
   * where the card's flash attention path is slow: Intel Arc under Vulkan
   * offers only 8-row matrix tiles, so flash attention falls back to scalar
   * code and prefill collapses as the context grows.
   */
  flashAttention: boolean;
  /** the one card to run on; unset lets the installed build use every card it sees */
  gpu?: LocalGpuChoice;
  /** requests the engine runs at once (exl3xpu only) */
  parallel: number;
  /** GiB of system RAM for idle requests' KV cache (exl3xpu only); 0 is none */
  ramCacheGiB: number;
};

/** A whole engine profile: the settings plus the model and its sampling. */
export type LocalEngineProfile = LocalEngineSettings & {
  /** installed model alias; unset runs the installation's default model */
  model?: string;
  /** sampling and fit knobs; unset knobs follow the model, then Atomic's defaults */
  tuning: LocalTuning;
  /**
   * Projector the running server was started with. Derived from the model's
   * registration rather than chosen, but part of the profile so that swapping
   * the projector alone still restarts the server.
   */
  mmproj?: string;
};

/** What callers send: any subset of a profile; the rest takes its default. */
export type LocalEngineProfileInput = Partial<LocalEngineProfile>;

/**
 * The valid fields of an untrusted record (a request body, a state file, a
 * hand-edited profile). An invalid field is dropped, never coerced, so it
 * takes its default when the profile is normalized.
 */
export function parseLocalEngineProfile(value: unknown): LocalEngineProfileInput {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const integer = (key: string, min: number) =>
    Number.isInteger(raw[key]) && Number(raw[key]) >= min ? Number(raw[key]) : undefined;
  const contextTokens = integer("contextTokens", 1);
  const reasoningTokens = integer("reasoningTokens", -1);
  const parallel = integer("parallel", 1);
  const gpu = parseLocalGpuChoice(raw.gpu);
  return {
    ...(typeof raw.model === "string" && raw.model.trim()
      ? { model: raw.model.trim() }
      : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(isLocalCacheType(raw.cacheK) ? { cacheK: raw.cacheK } : {}),
    ...(isLocalCacheType(raw.cacheV) ? { cacheV: raw.cacheV } : {}),
    ...(raw.tuning && typeof raw.tuning === "object"
      ? { tuning: parseLocalTuning(raw.tuning as Record<string, unknown>) }
      : {}),
    ...(typeof raw.kvOffload === "boolean" ? { kvOffload: raw.kvOffload } : {}),
    ...(typeof raw.flashAttention === "boolean"
      ? { flashAttention: raw.flashAttention }
      : {}),
    ...(gpu ? { gpu } : {}),
    ...(parallel !== undefined ? { parallel } : {}),
    ...(typeof raw.ramCacheGiB === "number" &&
    Number.isFinite(raw.ramCacheGiB) &&
    raw.ramCacheGiB >= 0
      ? { ramCacheGiB: raw.ramCacheGiB }
      : {}),
    ...(typeof raw.mmproj === "string" && raw.mmproj ? { mmproj: raw.mmproj } : {}),
  };
}

/** Every field set: the caller's value, else its default. */
export function normalizeLocalEngineProfile(
  input: LocalEngineProfileInput = {},
): LocalEngineProfile {
  const model = input.model?.trim();
  return {
    ...(model ? { model } : {}),
    contextTokens: input.contextTokens ?? DEFAULT_LOCAL_CONTEXT_TOKENS,
    reasoningTokens: input.reasoningTokens ?? DEFAULT_LOCAL_REASONING_TOKENS,
    cacheK: input.cacheK ?? DEFAULT_LOCAL_CACHE_K,
    cacheV: input.cacheV ?? DEFAULT_LOCAL_CACHE_V,
    tuning: { ...input.tuning },
    kvOffload: input.kvOffload ?? true,
    flashAttention: input.flashAttention ?? true,
    ...(input.gpu
      ? { gpu: { backend: input.gpu.backend, device: input.gpu.device, name: input.gpu.name } }
      : {}),
    parallel: input.parallel ?? 1,
    ramCacheGiB: input.ramCacheGiB ?? 0,
    ...(input.mmproj ? { mmproj: input.mmproj } : {}),
  };
}

/** True when an engine started for `left` already serves `right`. */
export function sameLocalEngineProfile(
  left: LocalEngineProfile,
  right: LocalEngineProfile,
): boolean {
  return (
    left.model === right.model &&
    left.contextTokens === right.contextTokens &&
    left.reasoningTokens === right.reasoningTokens &&
    left.cacheK === right.cacheK &&
    left.cacheV === right.cacheV &&
    left.kvOffload === right.kvOffload &&
    left.flashAttention === right.flashAttention &&
    sameLocalGpu(left.gpu, right.gpu) &&
    left.parallel === right.parallel &&
    left.ramCacheGiB === right.ramCacheGiB &&
    sameLocalTuning(left.tuning, right.tuning) &&
    left.mmproj === right.mmproj
  );
}

/** The engine-facing part of a profile, as the runtime's `start` takes it. */
export type LocalStartProfile = Omit<LocalEngineProfile, "model" | "mmproj">;

/**
 * Every (re)start must carry the whole profile. Leaving a field out relaunches
 * the engine on its defaults, which then no longer matches the profile NQ
 * records as active. The projector is not passed: the runtime reads it from
 * the model's registration, which is where the profile took it from.
 */
export function localStartOptions(
  profile: LocalEngineProfile,
): LocalStartProfile & { model?: string } {
  const { mmproj: _fromRegistration, ...options } = profile;
  return options;
}
