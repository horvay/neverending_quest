/**
 * Sealed transport between nq and a remote llama-server worker. The relay in
 * between (Runpod's load balancer) sees only ciphertext.
 *
 * Handshake: nq sends an ephemeral X25519 key; the worker answers with its own
 * ephemeral key, signed by its long-term Ed25519 identity, which nq pins. The
 * session secret comes from the ephemeral pair alone, so ciphertext logged in
 * transit stays sealed even if the identity key leaks later.
 *
 * Each request `seq` gets its own AES-256-GCM keys per direction. A request is
 * one sealed message; a response is a run of sealed frames (head, data…, end)
 * numbered from 0, so reordering, splicing and truncation all fail to open.
 *
 * Plain `node:crypto` only: the worker runs this under Node, nq under Bun.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import {
  FRAME_DATA,
  FRAME_END,
  FRAME_HEAD,
  SEAL_VERSION,
  type FrameType,
  type ResponseHead,
} from "./wire.ts";

export * from "./wire.ts";

const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const TAG_BYTES = 16;

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

function rawPublicKey(key: KeyObject): Buffer {
  return (key.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
}

function publicKeyFromRaw(prefix: Buffer, raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new SealError("public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "spki",
  });
}

function b64(buf: Buffer): string {
  return buf.toString("base64");
}

function unb64(text: unknown, what: string): Buffer {
  if (typeof text !== "string") throw new SealError(`missing ${what}`);
  return Buffer.from(text, "base64");
}

/** A worker identity, as stored: PKCS#8 private key and raw public key, base64. */
export type SealIdentity = { privateKey: string; publicKey: string };

export function generateSealIdentity(): SealIdentity {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: b64(
      pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer,
    ),
    publicKey: b64(rawPublicKey(pair.publicKey)),
  };
}

export function loadSealIdentity(privateKey: string): KeyObject {
  const key = createPrivateKey({
    key: unb64(privateKey, "identity"),
    format: "der",
    type: "pkcs8",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new SealError("identity must be an Ed25519 key");
  }
  return key;
}

export function sealIdentityPublicKey(privateKey: string): string {
  return b64(rawPublicKey(createPublicKey(loadSealIdentity(privateKey))));
}

function transcript(clientEph: Buffer, workerEph: Buffer): Buffer {
  return Buffer.concat([Buffer.from(SEAL_VERSION), clientEph, workerEph]);
}

function sessionSecret(shared: Buffer, clientEph: Buffer, workerEph: Buffer) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      transcript(clientEph, workerEph),
      `${SEAL_VERSION} session`,
      32,
    ),
  );
}

export type HelloRequest = { e: string };
export type HelloReply = { e: string; sig: string; sid: string };

export function startHello(): {
  request: HelloRequest;
  finish: (reply: unknown, pinnedWorkerKey: string) => Buffer;
} {
  const eph = generateKeyPairSync("x25519");
  const clientRaw = rawPublicKey(eph.publicKey);
  return {
    request: { e: b64(clientRaw) },
    finish: (reply, pinnedWorkerKey) => {
      const r = (reply ?? {}) as Partial<HelloReply>;
      const workerRaw = unb64(r.e, "worker key");
      const signed = verify(
        null,
        transcript(clientRaw, workerRaw),
        publicKeyFromRaw(ED25519_SPKI, unb64(pinnedWorkerKey, "pinned key")),
        unb64(r.sig, "signature"),
      );
      if (!signed) {
        throw new SealError("worker did not prove the pinned identity");
      }
      const shared = diffieHellman({
        privateKey: eph.privateKey,
        publicKey: publicKeyFromRaw(X25519_SPKI, workerRaw),
      });
      return sessionSecret(shared, clientRaw, workerRaw);
    },
  };
}

export function answerHello(
  identity: KeyObject,
  request: unknown,
): { reply: HelloReply; secret: Buffer } {
  const clientRaw = unb64((request as Partial<HelloRequest>)?.e, "client key");
  const eph = generateKeyPairSync("x25519");
  const workerRaw = rawPublicKey(eph.publicKey);
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: publicKeyFromRaw(X25519_SPKI, clientRaw),
  });
  return {
    reply: {
      e: b64(workerRaw),
      sig: b64(sign(null, transcript(clientRaw, workerRaw), identity)),
      sid: randomBytes(16).toString("base64url"),
    },
    secret: sessionSecret(shared, clientRaw, workerRaw),
  };
}

type Direction = "c2s" | "s2c";

function messageKey(secret: Buffer, dir: Direction, seq: number): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, Buffer.alloc(0), `${SEAL_VERSION} ${dir} ${seq}`, 32),
  );
}

function nonce(index: number): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64BE(BigInt(index), 4);
  return out;
}

function seal(key: Buffer, index: number, plain: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce(index));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

function open(key: Buffer, index: number, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new SealError("sealed message too short");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce(index));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new SealError("sealed message failed authentication");
  }
}

/** The plaintext HTTP request nq wants the worker's llama-server to see. */
export type InnerRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
};

export function sealRequest(secret: Buffer, seq: number, req: InnerRequest): Buffer {
  const head = Buffer.from(
    JSON.stringify({ method: req.method, path: req.path, headers: req.headers }),
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return seal(
    messageKey(secret, "c2s", seq),
    0,
    Buffer.concat([len, head, req.body]),
  );
}

export function openRequest(secret: Buffer, seq: number, sealed: Buffer): InnerRequest {
  const plain = open(messageKey(secret, "c2s", seq), 0, sealed);
  const headLen = plain.readUInt32BE(0);
  const head = JSON.parse(plain.subarray(4, 4 + headLen).toString()) as {
    method?: unknown;
    path?: unknown;
    headers?: unknown;
  };
  if (
    typeof head.method !== "string" ||
    typeof head.path !== "string" ||
    !head.path.startsWith("/")
  ) {
    throw new SealError("sealed request is malformed");
  }
  return {
    method: head.method,
    path: head.path,
    headers: (head.headers ?? {}) as Record<string, string>,
    body: plain.subarray(4 + headLen),
  };
}



/** Seals the response frames for one request, numbering them itself. */
export function responseSealer(secret: Buffer, seq: number) {
  const key = messageKey(secret, "s2c", seq);
  let index = 0;
  const frame = (type: FrameType, payload: Buffer) =>
    seal(key, index++, Buffer.concat([Buffer.from([type]), payload]));
  return {
    head: (head: ResponseHead) => frame(FRAME_HEAD, Buffer.from(JSON.stringify(head))),
    data: (chunk: Buffer) => frame(FRAME_DATA, chunk),
    end: () => frame(FRAME_END, Buffer.alloc(0)),
  };
}

/** Opens response frames in order; a gap, reorder or forgery throws. */
export function responseOpener(secret: Buffer, seq: number) {
  const key = messageKey(secret, "s2c", seq);
  let index = 0;
  return (sealed: Buffer): { type: FrameType; payload: Buffer } => {
    const plain = open(key, index++, sealed);
    const type = plain[0];
    if (type !== FRAME_HEAD && type !== FRAME_DATA && type !== FRAME_END) {
      throw new SealError("unknown frame type");
    }
    return { type, payload: plain.subarray(1) };
  };
}
