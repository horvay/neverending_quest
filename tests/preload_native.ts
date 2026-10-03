/**
 * Bun test preload. Must run before any file registers happy-dom.
 * happy-dom's Request/fetch drop Host and Origin (forbidden header names).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const g = globalThis as typeof globalThis & {
  __nqNativeRequest?: typeof Request;
  __nqNativeFetch?: typeof fetch;
  __nqNativeAbortController?: typeof AbortController;
  __nqNativeAbortSignal?: typeof AbortSignal;
};

if (g.__nqNativeRequest === undefined) {
  g.__nqNativeRequest = globalThis.Request;
}
if (g.__nqNativeFetch === undefined) {
  g.__nqNativeFetch = globalThis.fetch;
}
// Bun's fetch rejects a happy-dom signal outright, so a request with a
// timeout (the Local Inference Host's health check) fails under a DOM
if (g.__nqNativeAbortController === undefined) {
  g.__nqNativeAbortController = globalThis.AbortController;
}
if (g.__nqNativeAbortSignal === undefined) {
  g.__nqNativeAbortSignal = globalThis.AbortSignal;
}

/**
 * Tests never touch the player's machine: home, config, data, and auth all
 * live in a throwaway directory, so no test can find a real config, OMP auth
 * store, or a live local inference host. Each test injects its own fakes for
 * the Game Master's model, the engine, and the painter.
 */
const sandbox = mkdtempSync(path.join(os.tmpdir(), "nq-test-home-"));
process.env.HOME = sandbox;
process.env.XDG_DATA_HOME = path.join(sandbox, "data");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.XDG_CACHE_HOME = path.join(sandbox, "cache");
// Bun's os.homedir() ignores a HOME set at runtime, so OMP (which resolves
// ~/.omp from it) would still read and write the player's real agent dir:
// models.yml, the auth store, the model cache. Point OMP at the sandbox too.
process.env.PI_CODING_AGENT_DIR = path.join(sandbox, "omp", "agent");
process.env.PI_CONFIG_DIR = path.relative(
  os.homedir(),
  path.join(sandbox, "omp"),
);
process.on("exit", () => {
  rmSync(sandbox, { recursive: true, force: true });
});

