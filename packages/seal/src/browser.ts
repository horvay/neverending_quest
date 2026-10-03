/**
 * Browser half of the sealed transport (`protocol.ts`), on WebCrypto instead of
 * `node:crypto`. Same wire as the loopback proxy: an X25519 handshake pinned to
 * the worker's Ed25519 identity, then one AES-256-GCM sealed request per call
 * and a run of sealed response frames. The relay (Cloudflare, then Runpod's
 * load balancer) sees only ciphertext.
 *
 * Runs in the player's browser and, for tests, under Bun.
 */
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_HEAD,
  SEAL_CALL_PATH,
  SEAL_HELLO_PATH,
  SEAL_SEQ_HEADER,
  SEAL_SESSION_HEADER,
  SEAL_VERSION,
  type ResponseHead,
} from "./wire.ts";

type Bytes = Uint8Array<ArrayBuffer>;

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message || `relay answered ${status}`);
    this.name = "RelayError";
  }
}

export type SealedFetchOptions = {
  /** Where the relay forwards sealed calls, e.g. `https://nq.example/relay`. */
  relay: string;
  /** The worker's pinned Ed25519 public key, raw base64. */
  workerKey: string;
  fetch?: typeof fetch;
  /** A started reply that goes this long without a frame is failed. */
  stallMs?: number;
};

/** A plaintext request for the worker's llama-server, e.g. `/v1/chat/completions`. */
export type SealedFetch = (
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

/** llama-server streams steadily once a reply starts; this much silence is a stuck relay. */
const DEFAULT_STALL_MS = 90_000;
const FORWARDED_HEADERS = ["content-type", "accept"];
const enc = new TextEncoder();
const dec = new TextDecoder();

type Session = { sid: string; secret: Bytes };

export function createSealedFetch(opts: SealedFetchOptions): SealedFetch {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const relay = opts.relay.replace(/\/+$/, "");
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  let session: Promise<Session> | undefined;
  let seq = 0;

  const handshake = async (): Promise<Session> => {
    const eph = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const clientRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
    const res = await doFetch(`${relay}${SEAL_HELLO_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ e: toB64(clientRaw) }),
    });
    if (!res.ok) throw new RelayError(res.status, "sealed handshake refused");
    const reply = (await res.json()) as { e?: unknown; sig?: unknown; sid?: unknown };
    const workerRaw = fromB64(reply.e, "worker key");
    if (workerRaw.length !== 32) throw new SealError("worker key must be 32 bytes");
    const signed = transcript(clientRaw, workerRaw);
    const pinned = await crypto.subtle.importKey(
      "raw",
      fromB64(opts.workerKey, "pinned key"),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      pinned,
      fromB64(reply.sig, "signature"),
      signed,
    );
    if (!ok) throw new SealError("worker did not prove the pinned identity");
    const workerPub = await crypto.subtle.importKey(
      "raw",
      workerRaw,
      { name: "X25519" },
      false,
      [],
    );
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "X25519", public: workerPub },
        eph.privateKey,
        256,
      ),
    );
    if (typeof reply.sid !== "string") throw new SealError("no session id");
    return {
      sid: reply.sid,
      secret: await hkdf(shared, signed, `${SEAL_VERSION} session`),
    };
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

  return async (path, init) => {
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = init.headers?.[name] ?? init.headers?.[name.toLowerCase()];
      if (value) headers[name] = value;
    }
    const inner = {
      method: init.method ?? "GET",
      path,
      headers,
      body: init.body === undefined ? new Uint8Array(0) : enc.encode(init.body),
    };
    for (let attempt = 0; ; attempt++) {
      const s = await currentSession(attempt > 0);
      const mySeq = seq++;
      const res = await doFetch(`${relay}${SEAL_CALL_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          [SEAL_SESSION_HEADER]: s.sid,
          [SEAL_SEQ_HEADER]: String(mySeq),
        },
        body: await sealRequest(s.secret, mySeq, inner),
        signal: init.signal,
      });
      // a restarted worker forgot the session: handshake again, once
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel();
        continue;
      }
      if (!res.ok || !res.body) {
        throw new RelayError(res.status, await res.text().catch(() => ""));
      }
      return openStream(res.body, s.secret, mySeq, stallMs);
    }
  };
}

function transcript(clientEph: Bytes, workerEph: Bytes): Bytes {
  return concat(enc.encode(SEAL_VERSION), clientEph, workerEph);
}

async function hkdf(ikm: Bytes, salt: Bytes, info: string): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) },
      key,
      256,
    ),
  );
}

async function messageKey(
  secret: Bytes,
  dir: "c2s" | "s2c",
  seq: number,
): Promise<CryptoKey> {
  const raw = await hkdf(secret, new Uint8Array(0), `${SEAL_VERSION} ${dir} ${seq}`);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function nonce(index: number): Bytes {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, BigInt(index));
  return out;
}

async function sealRequest(
  secret: Bytes,
  seq: number,
  req: { method: string; path: string; headers: Record<string, string>; body: Bytes },
): Promise<Bytes> {
  const head = enc.encode(
    JSON.stringify({ method: req.method, path: req.path, headers: req.headers }),
  );
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.length);
  const key = await messageKey(secret, "c2s", seq);
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce(0) },
      key,
      concat(len, head, req.body),
    ),
  );
}

/** Opens response frames in order; a gap, reorder or forgery throws. */
async function responseOpener(secret: Bytes, seq: number) {
  const key = await messageKey(secret, "s2c", seq);
  let index = 0;
  return async (sealed: Bytes): Promise<{ type: number; payload: Bytes }> => {
    let plain: Bytes;
    try {
      plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(index++) }, key, sealed),
      );
    } catch {
      throw new SealError("sealed message failed authentication");
    }
    const type = plain[0]!;
    if (type !== FRAME_HEAD && type !== FRAME_DATA && type !== FRAME_END) {
      throw new SealError("unknown frame type");
    }
    return { type, payload: plain.subarray(1) };
  };
}

async function openStream(
  body: ReadableStream<Uint8Array>,
  secret: Bytes,
  seq: number,
  stallMs: number,
): Promise<Response> {
  const openFrame = await responseOpener(secret, seq);
  const reader = body.getReader();
  const frames = sseFrames(reader);
  const first = await frames.next();
  if (first.done) throw new SealError("relay closed before the response head");
  const head = await openFrame(first.value);
  if (head.type !== FRAME_HEAD) throw new SealError("response head missing");
  const meta = JSON.parse(dec.decode(head.payload)) as ResponseHead;

  let cancelled = false;
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
        if (next.done) throw new SealError("response was cut off before its end frame");
        const frame = await openFrame(next.value);
        if (frame.type === FRAME_DATA) controller.enqueue(frame.payload);
        else if (frame.type === FRAME_END) controller.close();
        else throw new SealError("unexpected frame");
      } catch (err) {
        // a reader that already hung up has nothing left to tell
        if (!cancelled) controller.error(err);
        await reader.cancel().catch(() => {});
      } finally {
        clearTimeout(stalled);
      }
    },
    cancel: () => {
      cancelled = true;
      return reader.cancel().catch(() => {});
    },
  });
  return new Response(stream, { status: meta.status, headers: meta.headers });
}

async function* sseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Bytes, void, undefined> {
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffered += dec.decode(value, { stream: true });
    let end: number;
    while ((end = buffered.indexOf("\n\n")) >= 0) {
      const event = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("");
      if (data) yield fromB64(data, "frame");
    }
  }
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function toB64(bytes: Bytes): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromB64(text: unknown, what: string): Bytes {
  if (typeof text !== "string") throw new SealError(`missing ${what}`);
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
