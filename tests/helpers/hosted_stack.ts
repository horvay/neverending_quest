import relayWorker, { type RelayEnv } from "../../src/surfaces/hosted/relay.ts";
import { createSealedFetch, type SealedFetch } from "@nq/seal/browser.ts";
import { generateSealIdentity } from "@nq/seal/protocol.ts";
import { startSealWorker, type SealWorker } from "@nq/seal/worker.ts";
import { startFakeLlama, type FakeLlama, type LlamaStep } from "./fake_llama.ts";

/**
 * The hosted Game Master path with only the model faked:
 *
 *   browser seal client → Cloudflare relay (in-process) → "Runpod" load
 *   balancer stand-in → real seal worker → fake llama-server
 *
 * The load-balancer stand-in is a plain pass-through that records every byte
 * crossing it, so tests can check the relay path carries only ciphertext.
 */
export type HostedStack = {
  readonly llama: FakeLlama;
  readonly env: RelayEnv;
  readonly apiKey: string;
  /** What the load balancer saw: request bodies and response bodies. */
  readonly seen: { requests: string[]; responses: string[]; authorizations: string[] };
  /** `fetch` that reaches the relay Worker, as the browser's fetch would. */
  relayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** A fresh browser seal client pointed at the relay. */
  sealedFetch(): SealedFetch;
  /** Kill and restart the GPU worker on the same port; it forgets sessions. */
  restartWorker(): Promise<void>;
  stop(): Promise<void>;
};

export const RELAY_ORIGIN = "http://relay.test";

export async function startHostedStack(
  opts: { steps?: LlamaStep[]; fallback?: LlamaStep } = {},
): Promise<HostedStack> {
  const llama = startFakeLlama(opts);
  const identity = generateSealIdentity();
  let worker: SealWorker = await startSealWorker({
    identity: identity.privateKey,
    upstream: llama.url,
    port: 0,
    host: "127.0.0.1",
  });
  const workerPort = worker.port;
  const seen = { requests: [] as string[], responses: [] as string[], authorizations: [] as string[] };
  const dec = new TextDecoder();

  const loadBalancer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.authorizations.push(request.headers.get("authorization") ?? "");
      const body =
        request.method === "GET" ? undefined : new Uint8Array(await request.arrayBuffer());
      if (body) seen.requests.push(dec.decode(body));
      const headers = new Headers();
      for (const name of ["content-type", "x-seal-session", "x-seal-seq"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const res = await fetch(`http://127.0.0.1:${workerPort}${url.pathname}`, {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
        signal: request.signal,
      });
      if (!res.body) return new Response(null, { status: res.status });
      // pass bytes through as they come, keeping a copy; a hang-up ends both sides
      const upstream = res.body.getReader();
      let text = "";
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        seen.responses.push(text);
      };
      const passed = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await upstream.read();
            if (next.done) {
              finish();
              controller.close();
              return;
            }
            text += dec.decode(next.value, { stream: true });
            controller.enqueue(next.value);
          } catch {
            finish();
            try {
              controller.error(new Error("upstream ended"));
            } catch {
              // the reader already hung up
            }
          }
        },
        cancel() {
          finish();
          void upstream.cancel().catch(() => {});
        },
      });
      return new Response(passed, { status: res.status, headers: res.headers });
    },
  });

  const apiKey = "rp_test_key";
  const env: RelayEnv = {
    RUNPOD_UPSTREAM: `http://127.0.0.1:${loadBalancer.port}`,
    RUNPOD_API_KEY: apiKey,
    WORKER_KEY: identity.publicKey,
  };
  const relayFetch = (input: string | URL | Request, init?: RequestInit) =>
    relayWorker.fetch(new Request(input, init), env);

  return {
    llama,
    env,
    apiKey,
    seen,
    relayFetch,
    sealedFetch: () =>
      createSealedFetch({
        relay: `${RELAY_ORIGIN}/relay`,
        workerKey: identity.publicKey,
        fetch: relayFetch as typeof fetch,
      }),
    async restartWorker() {
      await worker.close();
      worker = await startSealWorker({
        identity: identity.privateKey,
        upstream: llama.url,
        port: workerPort,
        host: "127.0.0.1",
      });
    },
    async stop() {
      loadBalancer.stop(true);
      await worker.close();
      llama.stop();
    },
  };
}
