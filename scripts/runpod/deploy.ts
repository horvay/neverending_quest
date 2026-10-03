/**
 * Deploys the sealed Game Master worker to an existing Runpod endpoint.
 *
 *   bun scripts/runpod/deploy.ts <endpoint-id>
 *
 * Builds packages/seal/src/worker.ts for Node, prepends it to boot.sh as the container
 * command, takes the model (`MODEL_URL`, `ALIAS`) from endpoint.json, keeps
 * the rest of the live env, and sets NQ_SEAL_KEY to the worker identity kept
 * (mode 0600) in ~/.config/nq/seal-worker.json, creating it on first run. Prints the
 * `[sealed]` block nq needs, including the public key it pins.
 *
 * The identity sits in the endpoint's env, which Runpod can read. That lets
 * someone with Runpod's access impersonate the worker going forward, but not
 * open traffic recorded earlier: session keys come from ephemeral X25519.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSealIdentity, type SealIdentity } from "@nq/seal/protocol.ts";

const NODE_URL =
  "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz";

const endpointId = process.argv[2];
if (!endpointId) {
  console.error("usage: bun scripts/runpod/deploy.ts <endpoint-id>");
  process.exit(2);
}

const apiKey =
  process.env.RUNPOD_API_KEY ??
  (await readFile(path.join(os.homedir(), ".runpod-api"), "utf8")).trim();
const api = `https://api.runpod.io/v2/serverless/${endpointId}`;
const headers = {
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
};

const identityPath = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "nq",
  "seal-worker.json",
);
let identity: SealIdentity;
try {
  identity = JSON.parse(await readFile(identityPath, "utf8")) as SealIdentity;
} catch {
  identity = generateSealIdentity();
  await mkdir(path.dirname(identityPath), { recursive: true });
  await writeFile(identityPath, JSON.stringify(identity), { mode: 0o600 });
  await chmod(identityPath, 0o600);
  console.log(`created worker identity ${identityPath}`);
}

const built = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "../../packages/seal/src/worker.ts")],
  target: "node",
  minify: true,
});
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
const bundle = await built.outputs[0]!.text();
if (bundle.includes("NQ_SEAL_BUNDLE_EOF")) throw new Error("bundle clashes with heredoc marker");
const boot = await readFile(path.join(import.meta.dir, "boot.sh"), "utf8");
const cmd = [
  "mkdir -p /opt/seal",
  "cat > /opt/seal/worker.mjs <<'NQ_SEAL_BUNDLE_EOF'",
  bundle,
  "NQ_SEAL_BUNDLE_EOF",
  boot,
].join("\n");

const current = (await (await fetch(api, { headers })).json()) as {
  env?: Record<string, string>;
  detail?: string;
};
if (!current.env) throw new Error(`endpoint lookup failed: ${current.detail}`);
const spec = JSON.parse(
  await readFile(path.join(import.meta.dir, "endpoint.json"), "utf8"),
) as { env: Record<string, string> };
const env = {
  ...current.env,
  MODEL_URL: spec.env.MODEL_URL!,
  ALIAS: spec.env.ALIAS!,
  NQ_SEAL_KEY: identity.privateKey,
  NODE_URL,
  PORT: "8080",
  PORT_HEALTH: "8080",
  HEALTH_CHECK_PATH: "/ping",
};
const res = await fetch(api, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ entrypoint: ["/bin/bash", "-c"], cmd: [cmd], env }),
});
const updated = (await res.json()) as {
  requestUrls?: { base?: string };
  detail?: string;
};
if (!res.ok) throw new Error(`endpoint update failed: ${updated.detail}`);

console.log(`deployed sealed worker to ${endpointId} (${bundle.length} byte bundle)`);
console.log(`
[sealed]
upstream = "${updated.requestUrls?.base ?? `https://${endpointId}.api.runpod.ai`}"
api_key = "!tr -d '[:space:]' < ~/.runpod-api"
worker_key = "${identity.publicKey}"
port = 8091`);
