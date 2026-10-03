/**
 * Engines never get the means to log the Game Master's text: NQ's real
 * runtime manager spawns the engine through its real detached spawn, with
 * logging variables set in the caller's environment. Faked: the engine, a
 * shell script standing in for llama-server that reports what it was given.
 */
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLocalRuntimeManager } from "@nq/local-inference/runtime.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { writeGgufFixture } from "../helpers/gguf.ts";
import { reservePort } from "../helpers/local_runtime.ts";

const LOGGING = {
  VLLM_DEBUG_LOG_API_SERVER_RESPONSE: "true",
  VLLM_LOGGING_LEVEL: "DEBUG",
  LLAMA_ARG_LOG_VERBOSITY: "10",
  LLAMA_LOG_FILE: "/tmp/llama.log",
  LLAMA_SERVER_SLOTS_DEBUG: "1",
  NQ_CAPTURE_REQUESTS: "/tmp/capture.jsonl",
};
let root: string | undefined;
let enginePid: number | undefined;

afterEach(async () => {
  for (const key of Object.keys(LOGGING)) delete process.env[key];
  if (enginePid) {
    try {
      process.kill(enginePid);
    } catch {}
  }
  enginePid = undefined;
  if (root) await rmTempDir(root);
  root = undefined;
});

test("an engine starts without core dumps and without any variable that would log prompts or replies", async () => {
  root = await makeTempDir("nq-engine-env-");
  const rootDir = path.join(root, "local");
  const report = path.join(root, "engine-report.txt");
  const serverPath = path.join(rootDir, "runtime", "build", "bin", "llama-server");
  const modelPath = path.join(rootDir, "models", "story.gguf");
  await mkdir(path.dirname(serverPath), { recursive: true });
  await mkdir(path.dirname(modelPath), { recursive: true });
  await writeGgufFixture(modelPath, { architecture: "qwen3", values: { "qwen3.block_count": 4 } });
  // llama-server stand-in: report what it was given, then answer /v1/models
  await writeFile(
    serverPath,
    `#!/bin/sh
{ echo "pid=$$"; echo "core=$(ulimit -c)"; env | grep -E '^(LLAMA_|VLLM_|NQ_CAPTURE)' ; } > "${report}"
port=""
while [ $# -gt 0 ]; do [ "$1" = "--port" ] && port="$2"; shift; done
exec "${process.execPath}" -e 'Bun.serve({ hostname: "127.0.0.1", port: Number(process.argv[1]), fetch: () => Response.json({ data: [{ id: "story" }] }) })' "$port"
`,
  );
  await chmod(serverPath, 0o755);
  const port = reservePort();
  await writeFile(
    path.join(rootDir, "installation.json"),
    JSON.stringify({
      schema: 2,
      runtime: {
        release: "test",
        target: { platform: "linux", arch: "x64", backend: "cpu", assetName: "x.tar.gz" },
        root: path.join(rootDir, "runtime"),
        serverPath,
      },
      models: [
        {
          alias: "story",
          source: modelPath,
          files: [{ name: "story.gguf", path: modelPath, external: true }],
          primaryPath: modelPath,
        },
      ],
      defaultModel: "story",
      lastPort: port,
    }),
  );

  Object.assign(process.env, LOGGING);
  const manager = createLocalRuntimeManager({ rootDir, modelsDir: path.join(rootDir, "models") });
  await manager.start({ model: "story", port, contextTokens: 4096 });

  const given = await readFile(report, "utf8");
  enginePid = Number(/pid=(\d+)/.exec(given)?.[1]);
  // a crash cannot write the engine's memory to disk
  expect(given).toContain("core=0");
  // and nothing reached it that switches on prompt or reply logging
  for (const key of Object.keys(LOGGING)) expect(given).not.toContain(key);
});
