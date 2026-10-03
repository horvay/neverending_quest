/**
 * The hosted book on the owner's own computer: `nq local share` (the real CLI,
 * in-process) loads the local Game Master through NQ's host and runs the seal
 * worker; the Cloudflare relay reaches it through a Workers VPC binding, and
 * the browser's seal client talks to it through the relay. Faked: the engine
 * (vLLM as exl3xpu runs it) and the VPC binding, which is Cloudflare's tunnel
 * to this machine (here, a pass-through that records what crosses it).
 */
import { afterEach, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import relayWorker, { type RelayEnv } from "../../src/surfaces/hosted/relay.ts";
import { connectGameMaster } from "../../src/agent/browser/connect.ts";
import { createSealedFetch } from "@nq/seal/browser.ts";
import { sealIdentityPublicKey } from "@nq/seal/protocol.ts";
import { freePort, runCli, startCli, waitForListen, type RunningCli } from "../helpers/cli.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { startLocalHost, type LocalHost } from "../helpers/local_host.ts";

const RELAY = "http://relay.test";
let host: LocalHost | undefined;
let share: RunningCli | undefined;
let root: string | undefined;

afterEach(async () => {
  await share?.stop();
  share = undefined;
  await host?.stop();
  host = undefined;
  if (root) await rmTempDir(root);
  root = undefined;
});

async function shareThisComputer() {
  host = await startLocalHost({
    defaultRoot: true,
    exl3: true,
    engine: { holdReasoning: false, reasoning: "The keeper weighs it.", reply: "The bell tolls once, far below." },
  });
  root = await makeTempDir("nq-share-");
  const configPath = path.join(root, "config.toml");
  await writeFile(configPath, `model = "llama.cpp/${host.alias}"\n`);
  const port = freePort();
  share = startCli(["--config", configPath, "local", "share", "--listen", String(port)]);
  await waitForListen(port, share, 30_000);
  const secrets = JSON.parse(await readFile(path.join(root, "share.json"), "utf8")) as {
    identity: string;
    token: string;
  };
  // what crosses Cloudflare's tunnel to this machine
  const crossed: string[] = [];
  const env: RelayEnv = {
    GM_BACKEND: "local",
    LOCAL_GM: {
      async fetch(input, init) {
        const body = init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "";
        crossed.push(body);
        const res = await fetch(`http://127.0.0.1:${port}${new URL(input).pathname}`, init);
        crossed.push(await res.clone().text());
        return res;
      },
    },
    LOCAL_GM_TOKEN: secrets.token,
    LOCAL_WORKER_KEY: sealIdentityPublicKey(secrets.identity),
    LOCAL_MODEL_NAME: "Twilight Embrace",
  };
  const relayFetch = (input: string | URL | Request, init?: RequestInit) =>
    relayWorker.fetch(new Request(input, init), env);
  return { port, secrets, env, crossed, relayFetch, configPath };
}

test("the hosted book plays on this computer's Game Master, sealed end to end through the relay", async () => {
  const { port, secrets, env, crossed, relayFetch } = await shareThisComputer();

  // the book learns which Game Master serves it, and its key, from the relay
  const gm = await connectGameMaster({ relay: `${RELAY}/relay`, fetch: relayFetch as typeof fetch });
  expect(gm.dialect).toBe("atomic");
  expect(gm.modelId).toBe("Twilight Embrace");

  const secretPrompt = "I ask the keeper about the drowned bell.";
  const res = await gm.transport("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen", stream: true, messages: [{ role: "user", content: secretPrompt }] }),
  });
  expect(res.status).toBe(200);
  const sse = await res.text();
  expect(sse).toContain("The bell tolls once, far below.");

  // vLLM got the prompt under its own served name, not the book's "qwen"
  const reached = host!.engine.completions.at(-1)!;
  expect(reached.model).toBe(host!.alias);
  expect(JSON.stringify(reached.messages)).toContain(secretPrompt);

  // nothing readable crossed the tunnel
  const wire = crossed.join("\n");
  expect(wire.length).toBeGreaterThan(0);
  for (const plain of [secretPrompt, "drowned bell", "bell tolls", "chat/completions"]) {
    expect(wire).not.toContain(plain);
  }
  // nor did the relay's secret reach the book
  const config = await (await relayFetch(`${RELAY}/relay/config`)).text();
  expect(config).not.toContain(secrets.token);

  // a sealed call may only ask for a chat completion: never the host's own routes
  const sealed = createSealedFetch({
    relay: `${RELAY}/relay`,
    workerKey: env.LOCAL_WORKER_KEY!,
    fetch: relayFetch as typeof fetch,
  });
  const control = await sealed("/.nq/status", { method: "GET" }).catch((err: Error) => err);
  expect(control instanceof Error ? control.message : String(control.status)).toMatch(/call not allowed|403/);

  // and only the relay's secret opens the worker at all
  expect((await fetch(`http://127.0.0.1:${port}/ping`)).status).toBe(401);
  expect(
    (await fetch(`http://127.0.0.1:${port}/ping`, { headers: { authorization: "Bearer guess" } })).status,
  ).toBe(401);
  expect(
    (await fetch(`http://127.0.0.1:${port}/ping`, { headers: { authorization: `Bearer ${secrets.token}` } }))
      .status,
  ).toBe(200);

  // stopping the share releases the Game Master
  const stopped = await share!.stop();
  share = undefined;
  expect(stopped.code).toBe(0);
  expect(stopped.stdout).toContain("Stopped sharing.");
});

test("while this computer is away the book falls back to OpenRouter, or says the Game Master is offline", async () => {
  const away: RelayEnv = {
    GM_BACKEND: "local",
    LOCAL_GM: { fetch: async () => { throw new Error("tunnel down"); } },
    LOCAL_GM_TOKEN: "secret",
    LOCAL_WORKER_KEY: "key",
  };
  const ask = async (env: RelayEnv) =>
    (await relayWorker.fetch(new Request(`${RELAY}/relay/config`), env)).json();

  expect(await ask({ ...away, OPENROUTER_API_KEY: "or-key", OPENROUTER_MODEL: "deepseek/deepseek-v4-flash" })).toEqual({
    backend: "openrouter",
    model: "deepseek/deepseek-v4-flash",
  });
  expect(await ask(away)).toEqual({ backend: "unavailable" });
  await expect(
    connectGameMaster({
      relay: `${RELAY}/relay`,
      fetch: ((input: string) => relayWorker.fetch(new Request(input), away)) as typeof fetch,
    }),
  ).rejects.toThrow("The Game Master is offline right now.");
});

test("players' calls are never captured, even with request capture on for the owner's own debugging", async () => {
  const capture = path.join(await makeTempDir("nq-capture-"), "capture.jsonl");
  process.env.NQ_CAPTURE_REQUESTS = capture;
  try {
    const { relayFetch } = await shareThisComputer();
    const gm = await connectGameMaster({ relay: `${RELAY}/relay`, fetch: relayFetch as typeof fetch });
    const playerPrompt = "I whisper my true name to the drowned bell.";
    const res = await gm.transport("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen", stream: true, messages: [{ role: "user", content: playerPrompt }] }),
    });
    expect(await res.text()).toContain("The bell tolls once");
    expect(JSON.stringify(host!.engine.completions.at(-1)!.messages)).toContain(playerPrompt);

    // the owner's own call through the same host is still captured, so capture really is on
    const ownPrompt = "Owner checking the capture file.";
    const own = await fetch(`${await host!.endpoint()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: host!.alias, messages: [{ role: "user", content: ownPrompt }] }),
    });
    await own.text();
    const captured = await readFile(capture, "utf8");
    expect(captured).toContain(ownPrompt);
    expect(captured).not.toContain(playerPrompt);
  } finally {
    delete process.env.NQ_CAPTURE_REQUESTS;
  }
});

test("share --keys makes the worker's identity and the relay's secret once, private to this user", async () => {
  root = await makeTempDir("nq-share-");
  const configPath = path.join(root, "config.toml");
  await writeFile(configPath, "");

  const first = await runCli(["--config", configPath, "local", "share", "--keys"]);
  expect(first.code).toBe(0);
  const file = path.join(root, "share.json");
  const secrets = JSON.parse(await readFile(file, "utf8")) as { identity: string; token: string };
  expect(first.stdout).toContain(`LOCAL_WORKER_KEY): ${sealIdentityPublicKey(secrets.identity)}`);
  expect(first.stdout).not.toContain(secrets.token);
  expect((await stat(file)).mode & 0o777).toBe(0o600);

  // the same identity every time, so the relay's pinned key stays valid
  const again = await runCli(["--config", configPath, "local", "share", "--keys"]);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ schema: 1, ...secrets });
  expect(again.stdout).toBe(first.stdout);
});
