/**
 * How "This computer"'s load page names engines, cards and sizes, for both
 * Player Surfaces.
 *
 * Pure: no Node, so the web book bundles it as the terminal Home imports it.
 */
import { LOCAL_CACHE_TYPES } from "@nq/local-inference/profile.ts";

/** KV cache types Atomic accepts, ordered from most accurate to smallest. */
export const CACHE_TYPES = LOCAL_CACHE_TYPES;

const ENGINE_NAMES: Readonly<Record<string, string>> = {
  "cuda-12.4": "CUDA",
  "cuda-13.3": "CUDA",
  vulkan: "Vulkan",
  rocm: "ROCm",
  metal: "Metal",
  cpu: "CPU",
};

/** The player's name for an engine build: "CUDA", "Vulkan", … */
export function engineName(backend: string): string {
  return ENGINE_NAMES[backend] ?? backend;
}

/**
 * Intel's Vulkan driver offers only 8-row matrix tiles, so flash attention
 * falls back to scalar code there and long prompts crawl; plain attention on
 * f16 caches measured about ten times faster at 8k tokens on an Arc Pro B70.
 */
export function prefersPlainAttention(gpu: { backend: string; name: string }): boolean {
  return gpu.backend === "vulkan" && /\bIntel\b/i.test(gpu.name);
}

/** One choice value per card; "" is Automatic. */
export function gpuKey(gpu: { backend: string; device: string; name: string }): string {
  return JSON.stringify([gpu.backend, gpu.device, gpu.name]);
}

export function formatModelSize(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
