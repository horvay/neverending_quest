import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const HOST_RECORD = "inference-host.json";

export const HOST_START_LOCK = "inference-host-start.lock";

export const HOST_PRODUCT = "neverending-quest-local-inference";

export const HOST_SCHEMA = 1;

export const HOST_PROTOCOL = 2;

export const HOST_START_TIMEOUT_MS = 30_000;

export const HOST_STOP_TIMEOUT_MS = 30_000;

// how long the host stays up after its last client exits; long enough that a
// client which is starting up has time to take its lease
export const HOST_IDLE_EXIT_MS = 60_000;

export const LOCAL_REASONING_CLIENT_PID_FIELD = "nq_client_pid";

export type LocalInferenceHostRecord = {
  schema: 1;
  pid: number;
  port: number;
  enginePort: number;
  token: string;
  startedAt: string;
  manualPin?: boolean;
};

export async function acquireStartLock(lockPath: string): Promise<boolean> {
  try {
    await mkdir(lockPath);
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
}

export async function endpointResponds(
  fetchImpl: typeof fetch,
  port: number,
): Promise<boolean> {
  try {
    await fetchImpl(`http://127.0.0.1:${port}/.nq/health`, {
      signal: AbortSignal.timeout(500),
    });
    return true;
  } catch {
    return false;
  }
}

export async function writeHostRecord(
  rootDir: string,
  record: LocalInferenceHostRecord,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  const target = path.join(rootDir, HOST_RECORD);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temp, target);
}

export async function readHostRecord(
  rootDir: string,
): Promise<LocalInferenceHostRecord | undefined> {
  try {
    return parseHostRecord(
      JSON.parse(await readFile(path.join(rootDir, HOST_RECORD), "utf8")),
    );
  } catch (error) {
    if (isCode(error, "ENOENT") || error instanceof SyntaxError)
      return undefined;
    throw error;
  }
}

export async function removeHostRecord(rootDir: string, token: string): Promise<void> {
  const current = await readHostRecord(rootDir);
  if (current && current.token !== token) return;
  await rm(path.join(rootDir, HOST_RECORD), { force: true });
}

function parseHostRecord(value: unknown): LocalInferenceHostRecord {
  if (!value || typeof value !== "object")
    throw new Error("Invalid local inference host record.");
  const raw = value as Record<string, unknown>;
  if (
    raw.schema !== HOST_SCHEMA ||
    !Number.isInteger(raw.pid) ||
    !Number.isInteger(raw.port) ||
    !Number.isInteger(raw.enginePort) ||
    typeof raw.token !== "string" ||
    typeof raw.startedAt !== "string"
  ) {
    throw new Error("Invalid local inference host record.");
  }
  return raw as LocalInferenceHostRecord;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code,
  );
}

export function nextPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port >= 65_535) {
    throw new Error(`Invalid local inference port: ${port}`);
  }
  return port + 1;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
