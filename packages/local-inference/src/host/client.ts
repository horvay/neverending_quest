import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { withoutCoreDumps } from "../process.ts";
import type { LocalEngineProfileInput } from "../profile.ts";
import {
  parseReasoningEndResult,
  type ReasoningEndResult,
} from "../engines/engine.ts";
import type {
  LocalIllustrationCandidate,
  LocalInferenceStatus,
} from "../inference.ts";
import {
  createLocalRuntimeManager,
  DEFAULT_LOCAL_MODEL_PORT,
  type LocalRuntimeManager,
  type LocalRuntimeStatus,
} from "../runtime.ts";
import {
  HOST_PRODUCT,
  HOST_PROTOCOL,
  HOST_SCHEMA,
  HOST_START_LOCK,
  HOST_START_TIMEOUT_MS,
  HOST_STOP_TIMEOUT_MS,
  type LocalInferenceHostRecord,
  acquireStartLock,
  endpointResponds,
  isPidAlive,
  nextPort,
  readHostRecord,
  removeHostRecord,
  writeHostRecord,
} from "./record.ts";

export type LocalInferenceHostStatus = LocalInferenceStatus & {
  hostRunning: boolean;
  runtime: LocalRuntimeStatus;
  clients: number;
  pinned: boolean;
  pid?: number;
  endpoint?: string;
};

export type LocalReasoningEndResult = ReasoningEndResult;

export type LocalInferenceHostClientOptions = {
  rootDir?: string;
  port?: number;
  enginePort?: number;
  entrypoint?: string;
  runtime?: LocalRuntimeManager;
  fetch?: typeof fetch;
  spawnHost?: (opts: {
    record: LocalInferenceHostRecord;
    rootDir: string;
    entrypoint: string;
    logPath: string;
  }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  clientPid?: number;
};

export class LocalInferenceHostClient {
  readonly rootDir: string;
  private readonly preferredPort: number;
  private readonly preferredEnginePort: number;
  private readonly entrypoint: string;
  private readonly runtime: LocalRuntimeManager;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnHost: NonNullable<
    LocalInferenceHostClientOptions["spawnHost"]
  >;
  private readonly clientPid: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: LocalInferenceHostClientOptions = {}) {
    this.runtime =
      opts.runtime ?? createLocalRuntimeManager({ rootDir: opts.rootDir });
    this.rootDir = this.runtime.rootDir;
    this.preferredPort = opts.port ?? DEFAULT_LOCAL_MODEL_PORT;
    this.preferredEnginePort = opts.enginePort ?? nextPort(this.preferredPort);
    this.entrypoint =
      opts.entrypoint ?? path.join(import.meta.dir, "..", "host_main.ts");
    this.fetchImpl = opts.fetch ?? fetch;
    this.spawnHost = opts.spawnHost ?? spawnDetachedHost;
    this.sleep = opts.sleep ?? Bun.sleep;
    this.clientPid = opts.clientPid ?? process.pid;
  }

  async activate(
    profile: LocalEngineProfileInput = {},
    opts: { signal?: AbortSignal; pin?: boolean } = {},
  ): Promise<LocalInferenceHostStatus> {
    const record = await this.ensureRunning();
    await this.control(record, "/.nq/activate", {
      method: "POST",
      body: JSON.stringify({
        ...profile,
        clientPid: this.clientPid,
        ...(opts.pin ? { pin: true } : {}),
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return this.statusFor(record);
  }

  async deactivate(): Promise<void> {
    const record = await this.liveRecord();
    if (!record) return;
    await this.control(record, "/.nq/deactivate", {
      method: "POST",
      body: JSON.stringify({ clientPid: this.clientPid }),
    });
  }

  async illustrate(opts: {
    prompt: string;
    seeds: readonly number[];
    outPaths: readonly string[];
    signal?: AbortSignal;
    onCandidate?: (candidate: LocalIllustrationCandidate) => void;
  }): Promise<readonly LocalIllustrationCandidate[]> {
    const record = await this.ensureRunning();
    const response = await this.control(record, "/.nq/illustrate", {
      method: "POST",
      body: JSON.stringify({
        prompt: opts.prompt,
        seeds: opts.seeds,
        outPaths: opts.outPaths,
      }),
      signal: opts.signal,
      stream: true,
    });
    if (!response.body)
      throw new Error("Local inference host returned no illustration stream.");

    const candidates: LocalIllustrationCandidate[] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const event = parseIllustrationEvent(line);
        if (event.type === "candidate") {
          candidates.push(event.candidate);
          opts.onCandidate?.(event.candidate);
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    }
    if (buffered.trim()) {
      const event = parseIllustrationEvent(buffered.trim());
      if (event.type === "error") throw new Error(event.message);
    }
    return candidates;
  }

  async endReasoning(): Promise<LocalReasoningEndResult> {
    const record = await this.liveRecord();
    if (!record) {
      return { success: false, message: "Local inference is not running." };
    }
    const response = await this.control(record, "/.nq/reasoning/end", {
      method: "POST",
      body: JSON.stringify({ clientPid: this.clientPid }),
    });
    return parseReasoningEndResult(await response.json());
  }

  async status(): Promise<LocalInferenceHostStatus> {
    const record = await this.liveRecord();
    if (!record) {
      return {
        hostRunning: false,
        phase: "idle",
        runtime: await this.runtime.status({ port: this.preferredEnginePort }),
        clients: 0,
        pinned: false,
        endpoint: `http://127.0.0.1:${this.preferredPort}`,
      };
    }
    return this.statusFor(record);
  }

  async stop(): Promise<void> {
    const record = await this.liveRecord();
    if (!record) {
      const runtime = await this.runtime.status();
      if (runtime.managed) await this.runtime.stop();
      return;
    }
    await this.control(record, "/.nq/stop", { method: "POST" });
    const deadline = Date.now() + HOST_STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await this.ping(record))) return;
      await this.sleep(100);
    }
    throw new Error("Local inference host did not stop within 30 seconds.");
  }

  async ensureRunning(): Promise<LocalInferenceHostRecord> {
    const live = await this.liveRecord();
    if (live) return live;
    await mkdir(this.rootDir, { recursive: true });

    const lockPath = path.join(this.rootDir, HOST_START_LOCK);
    if (!(await acquireStartLock(lockPath))) {
      const deadline = Date.now() + HOST_START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const joined = await this.liveRecord();
        if (joined) return joined;
        await this.sleep(100);
      }
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs < HOST_START_TIMEOUT_MS) {
        throw new Error(
          "Another NQ process is still starting local inference.",
        );
      }
      await rm(lockPath, { recursive: true, force: true });
      return this.ensureRunning();
    }

    try {
      const joined = await this.liveRecord();
      if (joined) return joined;

      const legacy = await this.runtime.status({ port: this.preferredPort });
      if (
        legacy.managed &&
        new URL(legacy.endpoint).port === String(this.preferredPort)
      ) {
        await this.runtime.stop();
      }
      if (await endpointResponds(this.fetchImpl, this.preferredPort)) {
        throw new Error(
          `http://127.0.0.1:${this.preferredPort} is already in use. Local inference cannot claim its stable endpoint.`,
        );
      }

      const record: LocalInferenceHostRecord = {
        schema: HOST_SCHEMA,
        pid: 0,
        port: this.preferredPort,
        enginePort: this.preferredEnginePort,
        token: randomUUID(),
        startedAt: new Date().toISOString(),
      };
      const logsDir = path.join(this.rootDir, "logs");
      await mkdir(logsDir, { recursive: true });
      const logPath = path.join(logsDir, "local-inference-host.log");
      await this.spawnHost({
        record,
        rootDir: this.rootDir,
        entrypoint: this.entrypoint,
        logPath,
      });
      const written = await readHostRecord(this.rootDir);
      if (!written)
        throw new Error("Local inference host did not write its run record.");

      const deadline = Date.now() + HOST_START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await this.ping(written)) return written;
        if (!isPidAlive(written.pid)) break;
        await this.sleep(100);
      }
      if (!isPidAlive(written.pid))
        await removeHostRecord(this.rootDir, written.token);
      throw new Error(`Local inference host did not start. See ${logPath}.`);
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async liveRecord(): Promise<LocalInferenceHostRecord | undefined> {
    const record = await readHostRecord(this.rootDir);
    if (!record) return undefined;
    const generation = await this.hostGeneration(record);
    if (generation === "current") return record;
    if (generation === "stale") {
      await this.control(record, "/.nq/stop", { method: "POST" });
      const deadline = Date.now() + HOST_STOP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (!(await endpointResponds(this.fetchImpl, record.port))) {
          await removeHostRecord(this.rootDir, record.token);
          return undefined;
        }
        await this.sleep(100);
      }
      throw new Error(
        `Stale local inference host PID ${record.pid} did not stop within 30 seconds.`,
      );
    }
    if (!isPidAlive(record.pid)) {
      await removeHostRecord(this.rootDir, record.token);
      return undefined;
    }
    throw new Error(
      `Local inference host PID ${record.pid} is alive but not responding. Refusing to replace it.`,
    );
  }

  private async statusFor(
    record: LocalInferenceHostRecord,
  ): Promise<LocalInferenceHostStatus> {
    const [response, runtime] = await Promise.all([
      this.control(record, "/.nq/status", { method: "GET" }),
      this.runtime.status({ port: record.enginePort }),
    ]);
    const raw = (await response.json()) as LocalInferenceStatus & {
      clients?: unknown;
      pinned?: unknown;
    };
    if (!Number.isInteger(raw.clients) || typeof raw.pinned !== "boolean") {
      throw new Error("Local inference host returned an invalid status.");
    }
    const body = {
      ...raw,
      clients: Number(raw.clients),
      pinned: raw.pinned,
    };
    return {
      ...body,
      hostRunning: true,
      runtime,
      pid: record.pid,
      endpoint: `http://127.0.0.1:${record.port}`,
    };
  }

  private async hostGeneration(
    record: LocalInferenceHostRecord,
  ): Promise<"current" | "stale" | "missing"> {
    try {
      const response = await this.fetchImpl(
        `http://127.0.0.1:${record.port}/.nq/health`,
        { signal: AbortSignal.timeout(500) },
      );
      if (!response.ok) return "missing";
      const body = (await response.json()) as Record<string, unknown>;
      if (body.product !== HOST_PRODUCT || body.pid !== record.pid) {
        return "missing";
      }
      return body.protocol === HOST_PROTOCOL ? "current" : "stale";
    } catch {
      return "missing";
    }
  }

  private async ping(record: LocalInferenceHostRecord): Promise<boolean> {
    return (await this.hostGeneration(record)) === "current";
  }

  private async control(
    record: LocalInferenceHostRecord,
    pathname: string,
    opts: {
      method: "GET" | "POST";
      body?: string;
      signal?: AbortSignal;
      stream?: boolean;
    },
  ): Promise<Response> {
    const response = await this.fetchImpl(
      `http://127.0.0.1:${record.port}${pathname}`,
      {
        method: opts.method,
        headers: {
          authorization: `Bearer ${record.token}`,
          ...(opts.body ? { "content-type": "application/json" } : {}),
        },
        ...(opts.body ? { body: opts.body } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        message || `Local inference host returned HTTP ${response.status}.`,
      );
    }
    return response;
  }
}

export function createLocalInferenceHostClient(
  opts: LocalInferenceHostClientOptions = {},
): LocalInferenceHostClient {
  return new LocalInferenceHostClient(opts);
}

async function spawnDetachedHost(opts: {
  record: LocalInferenceHostRecord;
  rootDir: string;
  entrypoint: string;
  logPath: string;
}): Promise<void> {
  const log = await open(opts.logPath, "a");
  try {
    // the host holds hosted players' calls in memory: no core dumps
    const [file, argv] = withoutCoreDumps(process.execPath, [
      opts.entrypoint,
      "__local-inference-host",
      opts.rootDir,
      String(opts.record.port),
      String(opts.record.enginePort),
      opts.record.token,
    ]);
    const child = spawn(
      file,
      argv,
      {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    if (!child.pid) throw new Error("Failed to spawn local inference host.");
    child.unref();
    await writeHostRecord(opts.rootDir, { ...opts.record, pid: child.pid });
  } finally {
    await log.close();
  }
}

type IllustrationWireEvent =
  | { type: "candidate"; candidate: LocalIllustrationCandidate }
  | { type: "completed" }
  | { type: "error"; message: string };

function parseIllustrationEvent(line: string): IllustrationWireEvent {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== "object")
    throw new Error("Invalid illustration event.");
  const raw = value as Record<string, unknown>;
  if (raw.type === "completed") return { type: "completed" };
  if (raw.type === "error" && typeof raw.message === "string") {
    return { type: "error", message: raw.message };
  }
  if (
    raw.type === "candidate" &&
    raw.candidate &&
    typeof raw.candidate === "object"
  ) {
    const candidate = raw.candidate as Record<string, unknown>;
    if (
      Number.isInteger(candidate.slot) &&
      Number.isInteger(candidate.seed) &&
      typeof candidate.path === "string"
    ) {
      return {
        type: "candidate",
        candidate: {
          slot: Number(candidate.slot),
          seed: Number(candidate.seed),
          path: candidate.path,
        },
      };
    }
  }
  throw new Error("Invalid illustration event.");
}
