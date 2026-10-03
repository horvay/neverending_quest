import { open, stat } from "node:fs/promises";
import path from "node:path";
import { ENGINES, engineNamed } from "./engines/registry.ts";
import { readRunRecord } from "./installation.ts";
import { defaultLocalRuntimeDir } from "./runtime.ts";

export const LOCAL_LOG_SOURCES = ["engine", "host"] as const;
export type LocalLogSource = (typeof LOCAL_LOG_SOURCES)[number];

export type LocalLogChunk = {
  source: LocalLogSource;
  /** The file read: the engine log follows whichever engine is running. */
  file: string;
  text: string;
  nextOffset: number;
  reset: boolean;
  available: boolean;
};

const HOST_LOG = "local-inference-host.log";

/**
 * The engine log to show: the running engine's (from its run record), else
 * whichever engine wrote last.
 */
async function engineLogFile(rootDir: string): Promise<string> {
  const run = await readRunRecord(rootDir).catch(() => undefined);
  if (run) return engineNamed(run.engine).logFile;
  // no engine running: the newest log, the first engine's on a tie
  let newest = { file: ENGINES[0]!.logFile, modified: -1 };
  for (const engine of ENGINES) {
    const modified =
      (await stat(path.join(rootDir, "logs", engine.logFile)).catch(() => undefined))
        ?.mtimeMs ?? -1;
    if (modified > newest.modified) newest = { file: engine.logFile, modified };
  }
  return newest.file;
}

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TAIL_BYTES = 128 * 1024;

export function isLocalLogSource(value: string): value is LocalLogSource {
  return (LOCAL_LOG_SOURCES as readonly string[]).includes(value);
}

export async function readLocalLogChunk(opts: {
  source: LocalLogSource;
  offset?: number;
  /** The file the offset belongs to; another file starts over from its tail. */
  file?: string;
  rootDir?: string;
  chunkBytes?: number;
  tailBytes?: number;
}): Promise<LocalLogChunk> {
  const rootDir = opts.rootDir ?? defaultLocalRuntimeDir();
  const name = opts.source === "host" ? HOST_LOG : await engineLogFile(rootDir);
  const filename = path.join(rootDir, "logs", name);
  // the engine changed since the last read: its offset means nothing here
  const switched = opts.file !== undefined && opts.file !== name;
  if (switched) opts = { ...opts, offset: undefined };
  const chunkBytes = positiveInteger(opts.chunkBytes, DEFAULT_CHUNK_BYTES);
  const tailBytes = positiveInteger(opts.tailBytes, DEFAULT_TAIL_BYTES);

  let file;
  try {
    file = await open(filename, "r");
  } catch (error) {
    if (isEnoent(error)) {
      return {
        source: opts.source,
        file: name,
        text: "",
        nextOffset: 0,
        reset: switched || (opts.offset !== undefined && opts.offset !== 0),
        available: false,
      };
    }
    throw error;
  }

  try {
    const size = (await file.stat()).size;
    const requested = validOffset(opts.offset);
    const reset = switched || (requested !== undefined && requested > size);
    let start =
      requested === undefined || reset
        ? Math.max(0, size - tailBytes)
        : requested;
    const length = Math.min(chunkBytes, Math.max(0, size - start));
    if (length === 0) {
      return {
        source: opts.source,
        file: name,
        text: "",
        nextOffset: start,
        reset,
        available: true,
      };
    }

    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    let textStart = 0;
    if ((requested === undefined || reset) && start > 0) {
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (newline >= 0) textStart = newline + 1;
    }
    const text = buffer.subarray(textStart, bytesRead).toString("utf8");
    start += bytesRead;
    return {
      source: opts.source,
      file: name,
      text,
      nextOffset: start,
      reset,
      available: true,
    };
  } finally {
    await file.close();
  }
}

function validOffset(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function isEnoent(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}
