/**
 * Providers served by an Atomic llama-server. `llama.cpp` is the engine nq
 * spawns on this machine; `llama.cpp-<name>` is a remote one declared in
 * `~/.omp/agent/models.yml` (a Runpod endpoint, say). Both get the local
 * request shaping (thinking prefill, reasoning control, prose filter), but
 * only `llama.cpp` is started and stopped by nq.
 */
export const LLAMA_CPP_PROVIDER = "llama.cpp";

export function isLlamaCppProvider(provider: string | undefined): boolean {
  if (!provider) return false;
  return (
    provider === LLAMA_CPP_PROVIDER ||
    provider.startsWith(`${LLAMA_CPP_PROVIDER}-`)
  );
}

/** True for a `<provider>/<model>` selector whose provider is llama.cpp-family. */
export function isLlamaCppModel(selector: string | undefined): boolean {
  const slash = selector?.indexOf("/") ?? -1;
  return slash > 0 && isLlamaCppProvider(selector!.slice(0, slash));
}

/** A llama.cpp-family model nq does not run itself. */
export function isRemoteLlamaCppModel(selector: string | undefined): boolean {
  return (
    isLlamaCppModel(selector) && !selector!.startsWith(`${LLAMA_CPP_PROVIDER}/`)
  );
}
