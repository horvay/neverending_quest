import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { complete } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadConfigFile } from "../../src/config.ts";
import { startSealedTransport, type SealedProxy } from "@nq/seal/client.ts";
import { generateSealIdentity } from "@nq/seal/protocol.ts";

type SealWorker = { port: number; close: () => Promise<void> };

/**
 * omp → nq sealed proxy → recording relay (Runpod's load balancer) → sealed
 * worker → fake llama-server. Only the engine and the relay are fakes; the
 * relay records every byte it carries, as a logging provider could. The
 * worker is the shipped bundle running under Node, as it does on Runpod.
 */

let workerBundle = "";
beforeAll(async () => {
  workerBundle = path.join(os.tmpdir(), `nq-seal-worker-${process.pid}.mjs`);
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "../../packages/seal/src/worker.ts")],
    target: "node",
  });
  if (!built.success) throw new Error("worker bundle failed");
  await Bun.write(workerBundle, built.outputs[0]!);
});

async function startSealWorker(opts: {
  identity: string;
  upstream: string;
  port: number;
}): Promise<SealWorker> {
  const child = Bun.spawn(["node", workerBundle], {
    env: {
      PATH: process.env.PATH ?? "",
      NQ_SEAL_WORKER_MAIN: "1",
      NQ_SEAL_KEY: opts.identity,
      NQ_SEAL_UPSTREAM: opts.upstream,
      PORT: String(opts.port),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  let out = "";
  while (!/listening on :(\d+)/.test(out)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`worker exited: ${out}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return {
    port: Number(/listening on :(\d+)/.exec(out)![1]),
    close: async () => {
      child.kill();
      await child.exited;
    },
  };
}

const SECRET_PROMPT = "The smuggler hides the ledger under the brine-well.";
const SECRET_REPLY = ["Mira ", "lifts the ", "brine-well lid."];
const RUNPOD_KEY = "rp-test-key";

type Harness = {
  proxy: SealedProxy;
  worker: SealWorker;
  engineCalls: Array<{ path: string; body: string }>;
  engineAborts: number;
  relayLog: string[];
  relay: {
    tamper: boolean;
    stallAfterChunks?: number;
    replayLast: () => Promise<Response>;
  };
  restartWorker: () => Promise<void>;
  stop: () => Promise<void>;
};

const running: Harness[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop();
});

async function harness(opts: { pinnedKey?: string } = {}): Promise<Harness> {
  const engineCalls: Harness["engineCalls"] = [];
  let engineAborts = 0;
  const engine = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ status: "ok" });
      const body = await req.text();
      engineCalls.push({ path, body });
      const slow = body.includes("slow");
      const long = body.includes("long");
      req.signal.addEventListener("abort", () => (engineAborts += 1));
      const reply = long
        ? Array.from({ length: 2000 }, (_, i) => `word${i} `)
        : SECRET_REPLY;
      const chunks = reply.map(
        (text) =>
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            model: "qwen",
            choices: [{ index: 0, delta: { content: text } }],
          })}\n\n`,
      );
      const stream = new ReadableStream({
        async pull(controller) {
          const next = chunks.shift();
          if (!next) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  id: "c1",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                })}\n\ndata: [DONE]\n\n`,
              ),
            );
            controller.close();
            return;
          }
          if (slow) await Bun.sleep(300);
          controller.enqueue(new TextEncoder().encode(next));
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const identity = generateSealIdentity();
  const bootWorker = () =>
    startSealWorker({
      identity: identity.privateKey,
      upstream: `http://127.0.0.1:${engine.port}`,
      port: 0,
    });
  let worker = await bootWorker();

  const relayLog: string[] = [];
  let lastCall: { headers: Headers; body: ArrayBuffer } | undefined;
  const relayState: { tamper: boolean; stallAfterChunks?: number } = {
    tamper: false,
  };
  const relay = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      if (req.headers.get("authorization") !== `Bearer ${RUNPOD_KEY}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const url = new URL(req.url);
      const body = await req.arrayBuffer();
      relayLog.push(`${req.method} ${url.pathname} ${Buffer.from(body).toString("latin1")}`);
      if (url.pathname === "/.seal/call") lastCall = { headers: req.headers, body };
      const res = await fetch(`http://127.0.0.1:${worker.port}${url.pathname}`, {
        method: req.method,
        headers: req.headers,
        ...(req.method === "GET" ? {} : { body }),
        signal: req.signal,
      });
      if (!res.body) return res;
      let flipped = false;
      let carried = 0;
      const tee = res.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, controller) {
            carried += 1;
            if (
              relayState.stallAfterChunks !== undefined &&
              carried > relayState.stallAfterChunks
            ) {
              await new Promise(() => {}); // a relay that stops forwarding
            }
            relayLog.push(Buffer.from(chunk).toString("latin1"));
            if (relayState.tamper && !flipped) {
              const at = Buffer.from(chunk).toString().indexOf("data: ");
              if (at >= 0) {
                const copy = Buffer.from(chunk);
                copy[at + 10] = copy[at + 10] === 65 ? 66 : 65;
                flipped = true;
                controller.enqueue(copy);
                return;
              }
            }
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(tee, { status: res.status, headers: res.headers });
    },
  });

  // nq's end comes up from its config file, the way `nq serve` starts it
  const configDir = await mkdtemp(path.join(os.tmpdir(), "nq-sealed-config-"));
  const configPath = path.join(configDir, "config.toml");
  await writeFile(
    configPath,
    [
      'model = "llama.cpp-runpod/qwen"',
      "[sealed]",
      `upstream = "http://127.0.0.1:${relay.port}"`,
      `api_key = "!echo ${RUNPOD_KEY}"`,
      `worker_key = "${opts.pinnedKey ?? identity.publicKey}"`,
      "port = 0",
      "",
    ].join("\n"),
  );
  const { sealed } = await loadConfigFile(configPath);
  const proxy = await startSealedTransport(sealed!, { stallMs: 400 });

  const h: Harness = {
    proxy,
    get worker() {
      return worker;
    },
    engineCalls,
    get engineAborts() {
      return engineAborts;
    },
    relayLog,
    relay: {
      get tamper() {
        return relayState.tamper;
      },
      set tamper(v: boolean) {
        relayState.tamper = v;
      },
      get stallAfterChunks() {
        return relayState.stallAfterChunks;
      },
      set stallAfterChunks(v: number | undefined) {
        relayState.stallAfterChunks = v;
      },
      replayLast: () =>
        fetch(`http://127.0.0.1:${relay.port}/.seal/call`, {
          method: "POST",
          headers: lastCall!.headers,
          body: lastCall!.body,
        }),
    },
    restartWorker: async () => {
      const port = worker.port;
      await worker.close();
      worker = await startSealWorker({
        identity: identity.privateKey,
        upstream: `http://127.0.0.1:${engine.port}`,
        port,
      });
    },
    stop: async () => {
      proxy.stop();
      await rm(configDir, { recursive: true, force: true });
      relay.stop(true);
      await worker.close();
      engine.stop(true);
    },
  } as Harness;
  running.push(h);
  return h;
}

function gameMaster(proxy: SealedProxy) {
  return buildModel({
    id: "qwen",
    name: "Qwen",
    provider: "llama.cpp-runpod",
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${proxy.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 45056,
    maxTokens: 4096,
  } as never);
}

async function ask(proxy: SealedProxy, prompt: string, signal?: AbortSignal) {
  return complete(
    gameMaster(proxy),
    { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    { apiKey: "none", maxRetries: 0, ...(signal ? { signal } : {}) } as never,
  );
}

function replyText(message: { content: Array<{ type: string; text?: string }> }) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

describe("sealed transport to a remote llama-server", () => {
  test("omp streams a Game Master reply while the relay only ever sees ciphertext", async () => {
    const h = await harness();

    const first = await ask(h.proxy, SECRET_PROMPT);
    expect(first.stopReason).toBe("stop");
    expect(replyText(first)).toBe(SECRET_REPLY.join(""));
    // a second Turn reuses the session with a fresh sequence number
    const second = await ask(h.proxy, `${SECRET_PROMPT} Again.`);
    expect(replyText(second)).toBe(SECRET_REPLY.join(""));

    expect(h.engineCalls).toHaveLength(2);
    expect(h.engineCalls[0]!.path).toBe("/v1/chat/completions");
    expect(h.engineCalls[0]!.body).toContain(SECRET_PROMPT);

    const carried = h.relayLog.join("\n");
    expect(carried).toContain("/.seal/hello");
    expect(carried).toContain("/.seal/call");
    for (const secret of ["smuggler", "ledger", "brine-well", "Mira", "chat/completions", "messages"]) {
      expect(carried).not.toContain(secret);
    }
    // ciphertext is not merely base64 of the plaintext either
    const decoded = carried
      .split(/data: |\n/)
      .map((part) => Buffer.from(part, "base64").toString("latin1"))
      .join("\n");
    expect(decoded).not.toContain("brine-well");

    // the wake-up probe is the one thing that crosses in the clear
    const ping = await fetch(`http://127.0.0.1:${h.proxy.port}/ping`);
    expect(ping.status).toBe(200);
  });

  test("replayed, tampered and plaintext traffic never reaches llama-server", async () => {
    const h = await harness();
    await ask(h.proxy, SECRET_PROMPT);
    expect(h.engineCalls).toHaveLength(1);

    const replay = await h.relay.replayLast();
    expect(replay.status).toBe(409);

    const plain = await fetch(
      `http://127.0.0.1:${h.worker.port}/v1/chat/completions`,
      { method: "POST", body: JSON.stringify({ messages: [] }) },
    );
    expect(plain.status).toBe(404);
    expect(h.engineCalls).toHaveLength(1);

    // a relay that alters a response frame is caught, not believed
    h.relay.tamper = true;
    const tampered = await ask(h.proxy, SECRET_PROMPT);
    expect(tampered.stopReason).toBe("error");
    expect(replyText(tampered)).not.toContain("Mira");
  });

  test("a worker that cannot prove the pinned identity gets nothing", async () => {
    const h = await harness({ pinnedKey: generateSealIdentity().publicKey });
    const reply = await ask(h.proxy, SECRET_PROMPT);
    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage ?? "").toContain("pinned identity");
    expect(h.engineCalls).toHaveLength(0);
    expect(h.relayLog.join("\n")).not.toContain("smuggler");
  });

  test("a restarted worker forgets the session and nq quietly handshakes again", async () => {
    const h = await harness();
    await ask(h.proxy, SECRET_PROMPT);
    await h.restartWorker();
    const reply = await ask(h.proxy, SECRET_PROMPT);
    expect(replyText(reply)).toBe(SECRET_REPLY.join(""));
    expect(h.relayLog.filter((line) => line.startsWith("POST /.seal/hello"))).toHaveLength(2);
  });

  test("interrupting a Turn stops generation on the worker", async () => {
    const h = await harness();
    const abort = new AbortController();
    const pending = ask(h.proxy, `${SECRET_PROMPT} slow`, abort.signal);
    await Bun.sleep(150);
    abort.abort();
    const reply = await pending;
    expect(reply.stopReason).toBe("aborted");
    const deadline = Date.now() + 2000;
    while (h.engineAborts === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(h.engineAborts).toBe(1);
  });

  test("a long reply streams through intact", async () => {
    const h = await harness();
    const reply = await ask(h.proxy, "Tell me a long tale.");
    expect(reply.stopReason).toBe("stop");
    const words = replyText(reply).trim().split(" ");
    expect(words).toHaveLength(2000);
    expect(words.at(-1)).toBe("word1999");
  });

  test("a relay that goes silent mid-reply fails the Turn instead of hanging it", async () => {
    const h = await harness();
    h.relay.stallAfterChunks = 2;
    const started = Date.now();
    const reply = await ask(h.proxy, `${SECRET_PROMPT} slow`);
    expect(reply.stopReason).toBe("error");
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
