/**
 * Runs before any app module: the Node globals the shared code expects, and
 * the files the bundle carries (Seed Packs, prompt markdown) mounted where
 * the code looks for them.
 */
import { Buffer } from "node:buffer";
import bundled from "virtual:nq-bundled-files";
import { mountMemory } from "./vfs.ts";

const g = globalThis as Record<string, unknown>;
g.Buffer ??= Buffer;
g.process ??= {
  env: {},
  platform: "linux",
  pid: 1,
  argv: [],
  versions: {},
  cwd: () => "/",
  nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
  on() {},
  off() {},
  once() {},
  emit() {},
  exit() {},
};

for (const [at, files] of Object.entries(bundled as Record<string, Record<string, string>>)) {
  mountMemory(at, files);
}
mountMemory("/tmp", {});
