/**
 * Worker half of the sealed transport: the only port the relay can reach.
 * It answers the relay's `/ping` health probe, performs the sealed handshake,
 * and opens each sealed call into a plain request to llama-server on
 * loopback. Anything else is refused, so llama-server never serves plaintext
 * across the relay. Never log request or response content here.
 *
 * Runs under Node (bundled by scripts/runpod/deploy.ts) and under Bun in tests.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual, type KeyObject } from "node:crypto";
import {
  answerHello,
  loadSealIdentity,
  openRequest,
  responseSealer,
  SEAL_CALL_PATH,
  SEAL_HELLO_PATH,
  SEAL_SEQ_HEADER,
  SEAL_SESSION_HEADER,
  SealError,
} from "./protocol.ts";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** NQ_SEAL_DEBUG=1 logs sizes and timings, never content. */
const DEBUG = process.env.NQ_SEAL_DEBUG === "1";
const debug = DEBUG
  ? (msg: string) => console.log(`[seal] ${new Date().toISOString().slice(11, 23)} ${msg}`)
  : () => {};
const MAX_SESSIONS = 32;
const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;
/** Sequence numbers this far below the highest seen are refused outright. */
const SEQ_WINDOW = 1024;

type Session = { secret: Buffer; seen: Set<number>; maxSeq: number; usedAt: number };

export type SealWorkerOptions = {
  /** PKCS#8 Ed25519 private key, base64. */
  identity: string;
  /** Plain llama-server base, e.g. http://127.0.0.1:8081 */
  upstream: string;
  port: number;
  host?: string;
  /**
   * Shared secret the relay sends as `authorization: Bearer <token>`. When set,
   * every route refuses a request without it, so a worker reachable by
   * anything but the relay still serves nobody else.
   */
  token?: string;
  /**
   * The only inner requests a sealed call may make, as "METHOD /path". Unset
   * forwards any, as on a dedicated GPU worker whose upstream is llama-server
   * alone; set it when the upstream also has routes the book must not reach.
   */
  allowedCalls?: readonly string[];
  /** Upstream path the `/ping` probe checks; default `/health`. */
  healthPath?: string;
  /** Headers added to every opened call before it goes upstream. */
  upstreamHeaders?: Readonly<Record<string, string>>;
};

export type SealWorker = { port: number; close: () => Promise<void> };

export function startSealWorker(opts: SealWorkerOptions): Promise<SealWorker> {
  const identity = loadSealIdentity(opts.identity);
  const sessions = new Map<string, Session>();
  const server = createServer((req, res) => {
    void route(req, res, identity, sessions, opts).catch(() => {
      if (!res.headersSent) plain(res, 500, "worker error");
      else res.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  identity: KeyObject,
  sessions: Map<string, Session>,
  opts: SealWorkerOptions,
): Promise<void> {
  if (opts.token !== undefined && !hasToken(req, opts.token)) {
    return plain(res, 401, "unauthorized");
  }
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && path === "/ping") {
    return ping(res, opts.upstream, opts.healthPath ?? "/health");
  }
  if (req.method === "POST" && path === SEAL_HELLO_PATH) {
    const body = await readBody(req);
    let answer;
    try {
      answer = answerHello(identity, JSON.parse(body.toString()));
    } catch {
      return plain(res, 400, "bad hello");
    }
    remember(sessions, answer.reply.sid, answer.secret);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.reply));
    return;
  }
  if (req.method === "POST" && path === SEAL_CALL_PATH) {
    return call(req, res, sessions, opts.upstream, opts.allowedCalls, opts.upstreamHeaders);
  }
  return plain(res, 404, "this endpoint only accepts sealed calls");
}

function hasToken(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from(String(req.headers.authorization ?? ""));
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function ping(res: ServerResponse, upstream: string, healthPath: string): Promise<void> {
  // 204 tells the load balancer the worker is still initializing
  const started = Date.now();
  try {
    const health = await fetch(`${upstream}${healthPath}`, {
      signal: AbortSignal.timeout(2000),
    });
    debug(`ping upstream ${health.status} in ${Date.now() - started}ms`);
    return plain(res, health.ok ? 200 : 204, health.ok ? "ok" : "");
  } catch (err) {
    debug(`ping upstream failed after ${Date.now() - started}ms: ${String(err)}`);
    return plain(res, 204, "");
  }
}

function remember(sessions: Map<string, Session>, sid: string, secret: Buffer) {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.usedAt > SESSION_IDLE_MS) sessions.delete(id);
  }
  while (sessions.size >= MAX_SESSIONS) {
    sessions.delete(sessions.keys().next().value!);
  }
  sessions.set(sid, { secret, seen: new Set(), maxSeq: -1, usedAt: now });
}

/** Accepts each sequence number once, tolerating concurrent requests. */
function claimSeq(session: Session, seq: number): boolean {
  if (!Number.isSafeInteger(seq) || seq < 0) return false;
  if (seq <= session.maxSeq - SEQ_WINDOW || session.seen.has(seq)) return false;
  session.seen.add(seq);
  if (seq > session.maxSeq) {
    session.maxSeq = seq;
    for (const old of session.seen) {
      if (old <= seq - SEQ_WINDOW) session.seen.delete(old);
    }
  }
  return true;
}

async function call(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
  upstream: string,
  allowedCalls: readonly string[] | undefined,
  upstreamHeaders: Readonly<Record<string, string>> | undefined,
): Promise<void> {
  const session = sessions.get(String(req.headers[SEAL_SESSION_HEADER] ?? ""));
  if (!session) return plain(res, 401, "unknown session");
  const seq = Number(req.headers[SEAL_SEQ_HEADER]);
  const body = await readBody(req);
  if (!claimSeq(session, seq)) return plain(res, 409, "sequence already used");
  session.usedAt = Date.now();

  let inner;
  try {
    inner = openRequest(session.secret, seq, body);
  } catch (err) {
    return plain(res, 400, err instanceof SealError ? "bad seal" : "bad call");
  }

  if (allowedCalls && !allowedCalls.includes(`${inner.method} ${inner.path.split("?")[0]}`)) {
    return plain(res, 403, "call not allowed");
  }

  // stop llama-server generating when the caller hangs up; Bun's node:http
  // only reports that on the socket, Node on the response
  const abort = new AbortController();
  const hangUp = () => {
    if (!res.writableFinished) abort.abort();
  };
  res.on("close", hangUp);
  req.on("aborted", hangUp);
  req.socket.on("close", hangUp);
  const sealer = responseSealer(session.secret, seq);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  let frames = 0, bytes = 0, blocked = 0;
  const started = Date.now();
  const progress = !DEBUG ? undefined : setInterval(() => {
    debug(`call ${seq} +${Date.now() - started}ms frames=${frames} bytes=${bytes} buffered=${res.writableLength} blockedWrites=${blocked}`);
  }, 3000);
  res.on("close", () => {
    if (progress) clearInterval(progress);
    debug(`call ${seq} closed +${Date.now() - started}ms frames=${frames} finished=${res.writableFinished} aborted=${abort.signal.aborted}`);
  });
  // waits out a slow relay instead of buffering the whole reply in memory
  const send = async (frame: Buffer) => {
    const line = `data: ${frame.toString("base64")}\n\n`;
    frames += 1;
    bytes += line.length;
    if (res.write(line) || res.destroyed) return;
    blocked += 1;
    await new Promise<void>((resume) => {
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        resume();
      };
      res.on("drain", done);
      res.on("close", done);
    });
  };

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${upstream}${inner.path}`, {
      method: inner.method,
      headers: { ...inner.headers, ...upstreamHeaders },
      ...(inner.method === "GET" || inner.method === "HEAD"
        ? {}
        : { body: new Uint8Array(inner.body) }),
      signal: abort.signal,
    });
  } catch {
    await send(sealer.head({ status: 502, headers: { "content-type": "text/plain" } }));
    await send(sealer.data(Buffer.from("llama-server unreachable")));
    await send(sealer.end());
    res.end();
    return;
  }

  const contentType = upstreamRes.headers.get("content-type");
  await send(
    sealer.head({
      status: upstreamRes.status,
      headers: contentType ? { "content-type": contentType } : {},
    }),
  );
  try {
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
        await send(sealer.data(Buffer.from(chunk)));
      }
    }
    await send(sealer.end());
  } catch {
    // the caller went away mid-stream; the missing end frame marks it cut
  }
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(text);
}

/** Entry point inside the Runpod worker. */
if (process.env.NQ_SEAL_WORKER_MAIN === "1") {
  const identity = process.env.NQ_SEAL_KEY;
  if (!identity) {
    console.error("[seal] NQ_SEAL_KEY is not set");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8080);
  const upstream = process.env.NQ_SEAL_UPSTREAM ?? "http://127.0.0.1:8081";
  startSealWorker({ identity, upstream, port }).then(
    (worker) => console.log(`[seal] sealed worker listening on :${worker.port}`),
    (err) => {
      console.error(`[seal] failed to start: ${String(err)}`);
      process.exit(1);
    },
  );
}
