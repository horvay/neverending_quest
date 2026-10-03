/**
 * nq half of the sealed transport: a loopback HTTP server that omp treats as
 * an ordinary llama-server. Every request is sealed before it leaves this
 * machine and every response opened on the way back; only `/ping` (the
 * wake-up probe) crosses the relay in the clear.
 */
import { execSync } from "node:child_process";
import {
  responseOpener,
  SEAL_CALL_PATH,
  SEAL_HELLO_PATH,
  SEAL_SEQ_HEADER,
  SEAL_SESSION_HEADER,
  sealRequest,
  SealError,
  startHello,
  FRAME_DATA,
  FRAME_END,
  FRAME_HEAD,
  type ResponseHead,
} from "./protocol.ts";

/**
 * `[sealed]` in the nq config: a loopback proxy on `port` seals every request to the worker
 * behind `upstream`. `api_key` follows omp's convention: `!command`, an
 * environment variable name, or the literal key.
 */
export type SealedConfig = {
  upstream: string;
  apiKey?: string;
  workerKey: string;
  port: number;
};

/** Answered by a running sealed proxy, so a second nq process can share it. */
export const SEAL_PROXY_HEALTH_PATH = "/.nq-seal/health";
const FORWARDED_HEADERS = ["content-type", "accept"];

export type SealedProxyOptions = {
  /** The relay in front of the worker, e.g. https://<id>.api.runpod.ai */
  upstream: string;
  /** Bearer token the relay requires (the Runpod API key). */
  apiKey?: string;
  /** The worker's pinned Ed25519 public key, raw base64. */
  workerKey: string;
  port: number;
  fetch?: typeof fetch;
  /** A started reply that goes this long without a frame is failed. */
  stallMs?: number;
};

/**
 * llama-server streams dozens of tokens a second once a reply starts, so a
 * minute and a half of silence is a stuck relay, not a slow model.
 */
const DEFAULT_STALL_MS = 90_000;

export type SealedProxy = { port: number; shared: boolean; stop: () => void };

type Session = { sid: string; secret: Buffer };

export async function startSealedProxy(
  opts: SealedProxyOptions,
): Promise<SealedProxy> {
  const doFetch = opts.fetch ?? fetch;
  const upstream = opts.upstream.replace(/\/+$/, "");
  const auth: Record<string, string> = opts.apiKey
    ? { authorization: `Bearer ${opts.apiKey}` }
    : {};
  let session: Promise<Session> | undefined;
  let seq = 0;

  const handshake = async (): Promise<Session> => {
    const hello = startHello();
    const res = await doFetch(`${upstream}${SEAL_HELLO_PATH}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(hello.request),
    });
    if (!res.ok) throw new RelayError(res.status, "sealed handshake refused");
    const reply = (await res.json()) as { sid?: unknown };
    const secret = hello.finish(reply, opts.workerKey);
    if (typeof reply.sid !== "string") throw new SealError("no session id");
    return { sid: reply.sid, secret };
  };

  const currentSession = (fresh: boolean): Promise<Session> => {
    if (fresh || !session) {
      session = handshake();
      session.catch(() => {
        session = undefined;
      });
    }
    return session;
  };

  const forward = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers.get(name);
      if (value) headers[name] = value;
    }
    const body = Buffer.from(await req.arrayBuffer());
    const inner = {
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      body,
    };
    for (let attempt = 0; ; attempt++) {
      const s = await currentSession(attempt > 0);
      const mySeq = seq++;
      const res = await doFetch(`${upstream}${SEAL_CALL_PATH}`, {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/octet-stream",
          [SEAL_SESSION_HEADER]: s.sid,
          [SEAL_SEQ_HEADER]: String(mySeq),
        },
        body: new Uint8Array(sealRequest(s.secret, mySeq, inner)),
        signal: req.signal,
      });
      // a restarted worker forgot the session: handshake again, once
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel();
        continue;
      }
      if (!res.ok || !res.body) {
        throw new RelayError(res.status, await res.text().catch(() => ""));
      }
      return openStream(res.body, s.secret, mySeq, opts.stallMs ?? DEFAULT_STALL_MS);
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === SEAL_PROXY_HEALTH_PATH) {
        return Response.json({ sealed: true, upstream });
      }
      if (url.pathname === "/ping") {
        try {
          const res = await doFetch(`${upstream}/ping`, {
            headers: auth,
            signal: req.signal,
          });
          return new Response(await res.text(), { status: res.status });
        } catch {
          return new Response("relay unreachable", { status: 502 });
        }
      }
      try {
        return await forward(req);
      } catch (err) {
        if (req.signal.aborted) return new Response(null, { status: 499 });
        // a failed seal is not transient: 421 keeps omp from retrying into it
        const status =
          err instanceof RelayError ? err.status : err instanceof SealError ? 421 : 502;
        const message =
          err instanceof SealError
            ? `sealed transport: ${err.message}`
            : err instanceof RelayError
              ? `relay: HTTP ${err.status} ${err.detail}`.trim()
              : "sealed transport: relay unreachable";
        return Response.json({ error: { message } }, { status });
      }
    },
  });
  return { port: server.port!, shared: false, stop: () => server.stop(true) };
}

class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`relay HTTP ${status}`);
  }
}

/**
 * Turns the relay's SSE stream of sealed frames back into the worker's
 * plaintext response. Resolves once the head frame opens; the body then
 * streams, and fails loudly if a frame is forged or the end frame never comes.
 */
async function openStream(
  body: ReadableStream<Uint8Array>,
  secret: Buffer,
  seq: number,
  stallMs: number,
): Promise<Response> {
  const openFrame = responseOpener(secret, seq);
  const reader = body.getReader();
  const frames = sseFrames(reader);
  const first = await frames.next();
  if (first.done) throw new SealError("relay closed before the response head");
  const head = openFrame(first.value);
  if (head.type !== FRAME_HEAD) throw new SealError("response head missing");
  const meta = JSON.parse(head.payload.toString()) as ResponseHead;
  const streaming = /event-stream/i.test(meta.headers["content-type"] ?? "");

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let stalled: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          frames.next(),
          new Promise<never>((_, fail) => {
            stalled = setTimeout(
              () => fail(new SealError(`no response frame for ${stallMs / 1000}s`)),
              stallMs,
            );
          }),
        ]);
        if (next.done) {
          throw new SealError("response was cut off before its end frame");
        }
        const frame = openFrame(next.value);
        if (frame.type === FRAME_DATA) controller.enqueue(frame.payload);
        else if (frame.type === FRAME_END) controller.close();
        else throw new SealError("unexpected frame");
      } catch (err) {
        // Bun ends an errored body like a finished one and omp would take the
        // cut reply as whole, so an event stream closes on the OpenAI failure
        // chunk instead; omp maps it to a transient error and retries the Turn
        if (streaming) {
          const failed = {
            id: "sealed-transport",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "error" }],
          };
          controller.enqueue(
            new TextEncoder().encode(
              `\n\ndata: ${JSON.stringify(failed)}\n\ndata: [DONE]\n\n`,
            ),
          );
          controller.close();
        } else {
          controller.error(err);
        }
        await reader.cancel().catch(() => {});
      } finally {
        clearTimeout(stalled);
      }
    },
    // cancel the relay read directly; a pending frames.next() would hold it
    cancel: () => reader.cancel().catch(() => {}),
  });
  return new Response(stream, { status: meta.status, headers: meta.headers });
}

async function* sseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Buffer, void, undefined> {
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffered += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffered.indexOf("\n\n")) >= 0) {
      const event = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("");
      if (data) yield Buffer.from(data, "base64");
    }
  }
}

/**
 * Starts the proxy, or reuses one another nq process already runs on the
 * port. Throws if something else holds the port.
 */
export async function ensureSealedProxy(
  opts: SealedProxyOptions,
): Promise<SealedProxy> {
  try {
    return await startSealedProxy(opts);
  } catch (err) {
    const res = await fetch(
      `http://127.0.0.1:${opts.port}${SEAL_PROXY_HEALTH_PATH}`,
      { signal: AbortSignal.timeout(1000) },
    ).catch(() => undefined);
    if (res?.ok) return { port: opts.port, shared: true, stop: () => {} };
    throw new Error(
      `Sealed proxy port ${opts.port} is taken by something else: ${String(err)}`,
    );
  }
}

/** omp's secret convention: `!command`, an environment variable, or a literal. */
export function resolveSecretSetting(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("!")) {
    const out = execSync(value.slice(1), { encoding: "utf8", timeout: 10_000 }).trim();
    return out || undefined;
  }
  return process.env[value] || value;
}

/** Brings up the loopback end of `[sealed]` for this nq process. */
export function startSealedTransport(
  config: SealedConfig,
  tuning: Pick<SealedProxyOptions, "stallMs"> = {},
): Promise<SealedProxy> {
  const apiKey = resolveSecretSetting(config.apiKey);
  return ensureSealedProxy({
    upstream: config.upstream,
    workerKey: config.workerKey,
    port: config.port,
    ...tuning,
    ...(apiKey ? { apiKey } : {}),
  });
}
