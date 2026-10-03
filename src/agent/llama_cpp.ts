import { isRemoteLlamaCppModel } from "../model_selector.ts";

export {
  isLlamaCppModel,
  isLlamaCppProvider,
  isRemoteLlamaCppModel,
  LLAMA_CPP_PROVIDER,
} from "../model_selector.ts";

export type RemoteEndpoint = { baseUrl: string; apiKey?: string };

export type RemoteWarmerDeps = {
  resolve?: (provider: string, id: string) => Promise<RemoteEndpoint | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
};

/**
 * Matches the endpoint's 15s idle timeout: a worker may have stopped since the
 * last wake, and a ping to one still running costs at most 15s of idle GPU.
 */
const WARM_INTERVAL_MS = 15_000;
/** The Runpod load balancer holds a request up to ~2 min while a worker boots. */
const WARM_REQUEST_MS = 150_000;

/**
 * Wakes a scale-to-zero remote llama-server ahead of the next Turn, so its
 * cold start overlaps with the player reading and typing. Fire-and-forget:
 * failures are ignored, since the Turn itself still waits for the worker.
 */
export function createRemoteWarmer(deps: RemoteWarmerDeps = {}) {
  const resolve = deps.resolve ?? resolveFromOmp;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const lastWarm = new Map<string, number>();
  return async (selector: string | undefined): Promise<void> => {
    if (!isRemoteLlamaCppModel(selector)) return;
    const at = now();
    if (at - (lastWarm.get(selector!) ?? -Infinity) < WARM_INTERVAL_MS) return;
    lastWarm.set(selector!, at);
    const slash = selector!.indexOf("/");
    try {
      const endpoint = await resolve(
        selector!.slice(0, slash),
        selector!.slice(slash + 1),
      );
      if (!endpoint) return;
      const native = endpoint.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
      await doFetch(`${native}/ping`, {
        headers: endpoint.apiKey
          ? { authorization: `Bearer ${endpoint.apiKey}` }
          : {},
        signal: AbortSignal.timeout(WARM_REQUEST_MS),
      });
    } catch {
      // a failed wake only costs the next Turn its cold start
    }
  };
}

async function resolveFromOmp(
  provider: string,
  id: string,
): Promise<RemoteEndpoint | undefined> {
  const { discoverAuthStorage, ModelRegistry } = await import(
    "@oh-my-pi/pi-coding-agent"
  );
  const storage = await discoverAuthStorage();
  try {
    await storage.reload();
    const registry = new ModelRegistry(storage);
    const model = registry.find(provider, id);
    if (!model?.baseUrl) return undefined;
    const apiKey = await registry.getApiKey(model);
    return { baseUrl: model.baseUrl, ...(apiKey ? { apiKey } : {}) };
  } finally {
    storage.close();
  }
}
