/**
 * `nq local share`: lends this computer's Game Master to the hosted book.
 *
 * Loads the configured local model with its saved engine profile and keeps it
 * loaded, then runs the seal worker on 127.0.0.1, where only a Cloudflare
 * Tunnel reaches it (the relay calls it through a Workers VPC binding). The
 * relay must present a shared secret; calls are sealed end to end between the
 * player's browser and this worker, and may only ask for chat completions.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfigFile, mergeConfig } from "../config.ts";
import { loadLocalProfiles, profileFromConfig } from "../home/local_profiles.ts";
import { prepareLocalGameMaster } from "../home/providers.ts";
import {
  createLocalInferenceHostClient,
  PRIVATE_REQUEST_HEADER,
} from "@nq/local-inference/host.ts";
import { generateSealIdentity, sealIdentityPublicKey } from "@nq/seal/protocol.ts";
import { startSealWorker } from "@nq/seal/worker.ts";

const DEFAULT_LISTEN_PORT = 8787;
const LOCAL_PREFIX = "llama.cpp/";
/** The only calls the book may make: a chat completion. */
const ALLOWED_CALLS = ["POST /v1/chat/completions"] as const;

type ShareSecrets = { schema: 1; identity: string; token: string };

export async function runShare(
  args: string[],
  configPath: string,
  signal?: AbortSignal,
): Promise<number> {
  let listenPort = DEFAULT_LISTEN_PORT;
  let keysOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--keys") {
      keysOnly = true;
      continue;
    }
    if (args[i] === "--listen" && args[i + 1] !== undefined) {
      listenPort = Number(args[++i]);
      if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
        throw new Error("--listen takes a port number.");
      }
      continue;
    }
    throw new Error("Usage: nq local share [--listen <port>] [--keys]");
  }
  const secretsPath = path.join(path.dirname(configPath), "share.json");
  const secrets = await loadOrCreateSecrets(secretsPath);
  const printKeys = () => {
    console.log(`Worker key (the relay's LOCAL_WORKER_KEY): ${sealIdentityPublicKey(secrets.identity)}`);
    console.log(`The relay's secret (LOCAL_GM_TOKEN) is the "token" in ${secretsPath}.`);
  };
  if (keysOnly) {
    printKeys();
    return 0;
  }

  const config = mergeConfig(await loadConfigFile(configPath), {});
  const model = config.model;
  if (!model?.startsWith(LOCAL_PREFIX)) {
    throw new Error("Pick a model on This computer first: `nq local share` lends the local Game Master.");
  }
  // this process holds decrypted calls: a crash must not dump them to disk
  noCoreDumps(process.pid);
  const host = createLocalInferenceHostClient();

  const alias = model.slice(LOCAL_PREFIX.length);
  const profile = (await loadLocalProfiles(configPath))[alias] ?? profileFromConfig(config);
  console.log(`Loading ${alias} for the hosted book…`);
  await prepareLocalGameMaster(host, model, {
    contextTokens: profile.contextTokens,
    reasoningTokens: profile.reasoningTokens,
    cacheK: profile.cacheK,
    cacheV: profile.cacheV,
    tuning: config.localTuning,
    kvOffload: profile.kvOffload,
    flashAttention: profile.flashAttention,
    ...(profile.gpu ? { gpu: profile.gpu } : {}),
    parallel: profile.parallel,
    ramCacheGiB: profile.ramCacheGiB,
    reasoning: config.reasoning,
    almanac: config.almanac,
  });
  const status = await host.status();
  const upstream = status.gameMasterEndpoint ?? status.endpoint;
  if (!upstream) throw new Error("The local Game Master did not come up.");

  const worker = await startSealWorker({
    identity: secrets.identity,
    upstream,
    port: listenPort,
    host: "127.0.0.1",
    token: secrets.token,
    allowedCalls: ALLOWED_CALLS,
    // the host never captures these, whatever capture is set to
    upstreamHeaders: { [PRIVATE_REQUEST_HEADER]: "1" },
  });
  console.log(`Sharing ${alias} with the hosted book on http://127.0.0.1:${worker.port}.`);
  printKeys();
  console.log("Stop with Ctrl-C.");

  await new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => resolve();
    signal?.addEventListener("abort", finish, { once: true });
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  await worker.close();
  await host.deactivate();
  console.log("Stopped sharing.");
  return 0;
}

/** Sets a running process's core-dump limit to zero (Linux `prlimit`). */
function noCoreDumps(pid: number): void {
  if (process.platform !== "linux") return;
  const result = Bun.spawnSync(["prlimit", `--pid=${pid}`, "--core=0:0"], { stderr: "pipe" });
  if (result.exitCode !== 0) {
    console.warn("Could not turn off core dumps for this process (prlimit failed).");
  }
}

/** The worker's identity and the relay's secret, made once and kept private. */
async function loadOrCreateSecrets(file: string): Promise<ShareSecrets> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<ShareSecrets>;
    if (typeof raw.identity === "string" && typeof raw.token === "string") {
      return { schema: 1, identity: raw.identity, token: raw.token };
    }
  } catch {
    // first share on this computer
  }
  const secrets: ShareSecrets = {
    schema: 1,
    identity: generateSealIdentity().privateKey,
    token: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return secrets;
}
