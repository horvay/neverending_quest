/** Small filesystem helpers shared across the package. */
import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Writes JSON beside the target, then renames it over, so readers never see half a file. */
export async function writeJsonAtomic(
  filename: string,
  value: unknown,
): Promise<void> {
  const temporary = `${filename}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filename);
}

export async function fileExists(filename: string): Promise<boolean> {
  try {
    const info = await stat(filename);
    return info.isFile();
  } catch {
    return false;
  }
}

export async function fileSizeOrZero(filename: string): Promise<number> {
  try {
    return (await stat(filename)).size;
  } catch {
    return 0;
  }
}

/** The tail of a log from `offset` on, at most `maxBytes`, for an error message. */
export async function readLogSince(
  filename: string,
  offset: number,
  maxBytes = 16_384,
): Promise<string> {
  let file;
  try {
    file = await open(filename, "r");
    const size = (await file.stat()).size;
    const attemptStart = Math.min(offset, size);
    const start = Math.max(attemptStart, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString("utf8").trim();
  } catch {
    return "";
  } finally {
    await file?.close();
  }
}

/** True when `candidate` is `root` or inside it. */
export function isManagedPath(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return (
    resolved === resolvedRoot ||
    resolved.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

export function safeChildPath(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(
      `Model filename escapes its install directory: ${relative}`,
    );
  }
  return resolved;
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A JSON file's top-level object; undefined when missing, unreadable or not an object. */
export async function readJsonObject(
  filename: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(filename, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
