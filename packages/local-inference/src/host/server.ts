import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseLocalEngineProfile,
  sameLocalEngineProfile,
  type LocalEngineProfile,
} from "../profile.ts";
import type { InstalledLocalModel } from "../installation.ts";
import type { AnswerNowSlot, Engine, ReasoningEnd } from "../engines/engine.ts";
import { LocalInferenceController } from "../inference.ts";
import {
  createLocalRuntimeManager,
  type LocalRuntimeManager,
} from "../runtime.ts";
import {
  HOST_IDLE_EXIT_MS,
  HOST_PRODUCT,
  HOST_PROTOCOL,
  HOST_SCHEMA,
  LOCAL_REASONING_CLIENT_PID_FIELD,
  type LocalInferenceHostRecord,
  errorMessage,
  isPidAlive,
  removeHostRecord,
  writeHostRecord,
} from "./record.ts";

export async function runLocalInferenceHostProcess(args: {
  rootDir: string;
  port: number;
  enginePort: number;
  token: string;
  runtime?: LocalRuntimeManager;
  /** overrides how long the host lingers once idle; for tests */
  idleExitMs?: number;
  /** overrides how often leases are swept; for tests */
  sweepMs?: number;
}): Promise<number> {
  const runtime =
    args.runtime ?? createLocalRuntimeManager({ rootDir: args.rootDir });
  const inference = await LocalInferenceController.open({
    runtime,
    enginePort: args.enginePort,
  });
  let publicPort = args.port;
  const leases = new Map<number, LocalEngineProfile>();
  // per client, the "Answer now" of the completion it is waiting on
  const answerNow = new Map<number, ReasoningEnd>();
  // per model alias, the engine serving it; the catalog scan is too slow per request
  const served = new Map<string, Promise<{ engine: Engine; model?: InstalledLocalModel }>>();
  const servedBy = (alias: string | undefined) => {
    const key = alias ?? "";
    let entry = served.get(key);
    if (!entry) {
      entry = runtime.servingEngine(alias);
      entry.catch(() => served.delete(key));
      served.set(key, entry);
    }
    return entry;
  };
  let manualPin = false;
  const hostRecord: LocalInferenceHostRecord = {
    schema: HOST_SCHEMA,
    pid: process.pid,
    port: args.port,
    enginePort: args.enginePort,
    token: args.token,
    startedAt: new Date().toISOString(),
  };
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stopping = false;
  let server: ReturnType<typeof Bun.serve>;
  let leaseSweep: ReturnType<typeof setInterval> | undefined;

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(leaseSweep);
    leaseSweep = undefined;
    // Never swallow this: a close that fails leaves Atomic alive holding the GPU,
    // and the next start fits its layers to whatever VRAM the orphan left free.
    await inference.close().catch((error: unknown) => {
      console.error(
        `Local inference host could not stop Atomic: ${errorMessage(error)}`,
      );
    });
    server.stop(true);
    await removeHostRecord(args.rootDir, args.token);
    finish();
  };

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: args.port,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/.nq/health") {
        return Response.json({
          product: HOST_PRODUCT,
          protocol: HOST_PROTOCOL,
          pid: process.pid,
        });
      }
      if (url.pathname.startsWith("/.nq/")) {
        if (request.headers.get("authorization") !== `Bearer ${args.token}`) {
          return new Response("Unauthorized", { status: 401 });
        }
        try {
          if (url.pathname === "/.nq/status" && request.method === "GET") {
            pruneDeadLeases(leases);
            return Response.json({
              ...inference.status(`http://127.0.0.1:${publicPort}`),
              clients: leases.size,
              pinned: manualPin,
            });
          }
          if (url.pathname === "/.nq/activate" && request.method === "POST") {
            const body = await request.json().catch(() => ({}));
            const requested = await inference.resolveProfile(
              parseLocalEngineProfile(body),
            );
            const pin = parsePin(body);
            const clientPid = pin ? undefined : parseClientPid(body);
            pruneDeadLeases(leases);
            const active = inference.status().activeProfile;
            const otherClient = [...leases.keys()].some(
              (pid) => pid !== clientPid,
            );
            if (
              active &&
              (manualPin || otherClient) &&
              !sameLocalEngineProfile(active, requested)
            ) {
              throw new Error(
                "Another NQ process is using a different local Game Master profile.",
              );
            }
            const priorLease =
              clientPid === undefined ? undefined : leases.get(clientPid);
            const priorPin = manualPin;
            if (clientPid !== undefined) leases.set(clientPid, requested);
            if (pin) manualPin = true;
            try {
              // the catalog may have changed since: a new model, a new projector
              served.clear();
              await inference.activate(requested, request.signal);
              hostRecord.manualPin = manualPin;
              await writeHostRecord(args.rootDir, hostRecord);
            } catch (error) {
              if (clientPid !== undefined) {
                if (priorLease) leases.set(clientPid, priorLease);
                else leases.delete(clientPid);
              }
              manualPin = priorPin;
              throw error;
            }
            return Response.json({
              ...inference.status(`http://127.0.0.1:${publicPort}`),
              clients: leases.size,
              pinned: manualPin,
            });
          }
          if (url.pathname === "/.nq/deactivate" && request.method === "POST") {
            const body = await request.json().catch(() => ({}));
            leases.delete(parseClientPid(body));
            pruneDeadLeases(leases);
            if (leases.size === 0 && !manualPin) await inference.deactivate();
            return new Response(null, { status: 204 });
          }
          if (url.pathname === "/.nq/illustrate" && request.method === "POST") {
            const body = parseIllustrationRequest(await request.json());
            const abort = new AbortController();
            const onAbort = () => abort.abort();
            request.signal.addEventListener("abort", onAbort, { once: true });
            const stream = new ReadableStream<Uint8Array>({
              start(streamController) {
                const encoder = new TextEncoder();
                const emit = (value: unknown) => {
                  streamController.enqueue(
                    encoder.encode(`${JSON.stringify(value)}\n`),
                  );
                };
                void inference
                  .illustrate({
                    ...body,
                    signal: abort.signal,
                    onCandidate: (candidate) =>
                      emit({ type: "candidate", candidate }),
                  })
                  .then(() => emit({ type: "completed" }))
                  .catch((error) =>
                    emit({ type: "error", message: errorMessage(error) }),
                  )
                  .finally(() => {
                    request.signal.removeEventListener("abort", onAbort);
                    streamController.close();
                  });
              },
              cancel() {
                abort.abort();
              },
            });
            return new Response(stream, {
              headers: { "content-type": "application/x-ndjson" },
            });
          }
          if (
            url.pathname === "/.nq/reasoning/end" &&
            request.method === "POST"
          ) {
            const body = await request.json().catch(() => ({}));
            const clientPid = parseClientPid(body);
            pruneDeadLeases(leases);
            if (!leases.has(clientPid)) {
              return Response.json(
                {
                  success: false,
                  message: "Local Game Master lease is not active.",
                },
                { status: 409 },
              );
            }
            const end = answerNow.get(clientPid);
            if (!end) {
              return Response.json({
                success: false,
                message: "No active local reasoning block.",
              });
            }
            return Response.json(await end());
          }
          if (url.pathname === "/.nq/stop" && request.method === "POST") {
            setTimeout(() => void shutdown(), 10);
            return new Response(null, { status: 202 });
          }
          return new Response("Not found", { status: 404 });
        } catch (error) {
          return new Response(errorMessage(error), { status: 409 });
        }
      }
      return proxyTextRequest(request, {
        enginePort: args.enginePort,
        inference,
        answerNow,
        rootDir: args.rootDir,
        servedBy,
      });
    },
  });

  const boundPort = server.port;
  if (boundPort === undefined) {
    throw new Error("Local inference host did not bind a TCP port.");
  }
  publicPort = boundPort;
  hostRecord.port = boundPort;
  let idleSince: number | undefined;
  leaseSweep = setInterval(() => {
    pruneDeadLeases(leases);
    if (leases.size > 0 || manualPin) {
      idleSince = undefined;
      return;
    }
    if (inference.status().activeProfile) {
      void inference.deactivate().catch(() => undefined);
    }
    // nothing is using us any more: release the port and the code we loaded at
    // spawn, so the next client starts a host running the current source
    idleSince ??= Date.now();
    if (Date.now() - idleSince >= (args.idleExitMs ?? HOST_IDLE_EXIT_MS))
      void shutdown();
  }, args.sweepMs ?? 2_000);
  leaseSweep.unref();
  await writeHostRecord(args.rootDir, hostRecord);

  const onSignal = () => void shutdown();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  await stopped;
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGINT", onSignal);
  return 0;
}

/**
 * Forwards one OpenAI-compatible request to the engine once the Game Master
 * may take text, through the engine that serves the active profile.
 */
async function proxyTextRequest(
  request: Request,
  ctx: {
    enginePort: number;
    inference: LocalInferenceController;
    answerNow: Map<number, ReasoningEnd>;
    rootDir: string;
    servedBy: (
      alias: string | undefined,
    ) => Promise<{ engine: Engine; model?: InstalledLocalModel }>;
  },
): Promise<Response> {
  let release: (() => void) | undefined;
  try {
    await captureIncomingRequest(request, ctx.rootDir);
    const acquired = await ctx.inference.acquireTextRequest(request.signal);
    let released = false;
    release = () => {
      if (released) return;
      released = true;
      acquired();
    };
    const profile = ctx.inference.status().activeProfile;
    if (!profile) throw new Error("No local Game Master is active.");
    const { engine, model } = await ctx.servedBy(profile.model);
    const source = new URL(request.url);
    const prepared = await prepareTextProxyRequest(
      request,
      source.pathname,
      ctx.rootDir,
    );
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete(PRIVATE_REQUEST_HEADER);
    headers.delete("content-length");
    return await engine.forward({
      method: request.method,
      pathname: source.pathname,
      target: new URL(
        `${source.pathname}${source.search}`,
        `http://127.0.0.1:${ctx.enginePort}`,
      ),
      headers,
      ...(prepared.body === undefined ? {} : { body: prepared.body }),
      signal: request.signal,
      ...(prepared.clientPid === undefined ? {} : { clientPid: prepared.clientPid }),
      ...(model ? { model } : {}),
      profile,
      answerNow: answerNowSlot(ctx.answerNow, prepared.clientPid),
      release,
    });
  } catch (error) {
    release?.();
    return Response.json(
      {
        error: {
          message: errorMessage(error),
          type: "local_inference_unavailable",
        },
      },
      { status: 503 },
    );
  }
}

/** One request's hold on its client's "Answer now". */
function answerNowSlot(
  registry: Map<number, ReasoningEnd>,
  clientPid: number | undefined,
): AnswerNowSlot {
  let mine: ReasoningEnd | undefined;
  return {
    offer(end) {
      if (clientPid === undefined) return;
      mine = end;
      registry.set(clientPid, end);
    },
    withdraw() {
      if (clientPid !== undefined && mine && registry.get(clientPid) === mine) {
        registry.delete(clientPid);
      }
      mine = undefined;
    },
  };
}

type PreparedTextProxyRequest = {
  body?: BodyInit;
  /** The leased client behind a completion, which it may cut short. */
  clientPid?: number;
};

async function prepareTextProxyRequest(
  request: Request,
  pathname: string,
  rootDir: string,
): Promise<PreparedTextProxyRequest> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  if (!COMPLETION_PATHS.has(pathname)) {
    if (!request.body) return {};
    if (!(await requestCaptureTarget(rootDir))) return { body: request.body };
    const raw = await request.text();
    return raw ? { body: raw } : {};
  }

  const text = await request.text();
  if (!text) return {};
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { body: text };
    }
    const body = raw as Record<string, unknown>;
    const pid = body[LOCAL_REASONING_CLIENT_PID_FIELD];
    delete body[LOCAL_REASONING_CLIENT_PID_FIELD];
    return {
      body: JSON.stringify(body),
      ...(Number.isInteger(pid) && Number(pid) > 0
        ? { clientPid: Number(pid) }
        : {}),
    };
  } catch {
    return { body: text };
  }
}

/**
 * Capture is enabled by writing the destination path into <rootDir>/capture-requests,
 * which is read per request so it can be switched on without restarting the host.
 * NQ_CAPTURE_REQUESTS still works for a host started with it.
 */
/** Where the host appends every request it forwards, if capture is on. */
/**
 * Marks a request someone else made through this host, a hosted player's call
 * opened by the seal worker: it is never captured, whatever capture is set to,
 * and the marker goes no further than the host.
 */
export const PRIVATE_REQUEST_HEADER = "x-nq-private";

export async function requestCaptureTarget(rootDir: string): Promise<string | undefined> {
  const fromEnv = process.env.NQ_CAPTURE_REQUESTS?.trim();
  if (fromEnv) return fromEnv;
  try {
    const target = (
      await readFile(path.join(rootDir, "capture-requests"), "utf8")
    ).trim();
    return target ? target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Append the exact payload sent upstream, so a bad generation can be replayed
 * against the engine verbatim instead of being reconstructed by hand.
 */
async function captureIncomingRequest(
  request: Request,
  rootDir: string,
): Promise<void> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body)
    return;
  if (request.headers.has(PRIVATE_REQUEST_HEADER)) return;
  const target = await requestCaptureTarget(rootDir);
  if (!target) return;
  let body: string;
  try {
    body = await request.clone().text();
  } catch {
    return;
  }
  await captureProxyRequest(new URL(request.url).pathname, body, target);
}

async function captureProxyRequest(
  pathname: string,
  body: unknown,
  target: string,
): Promise<void> {
  if (typeof body !== "string") return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    path: pathname,
    body,
  });
  try {
    await appendFile(target, `${line}\n`, "utf8");
  } catch {
    // capture is a debugging aid, never fail the request for it
  }
}

/** The completions a client tags with its PID, so it can end their reasoning. */
const COMPLETION_PATHS = new Set([
  "/chat/completions",
  "/v1/chat/completions",
  "/responses",
  "/v1/responses",
]);

function parseClientPid(value: unknown): number {
  if (!value || typeof value !== "object") {
    throw new Error("A local inference client identity is required.");
  }
  const pid = (value as Record<string, unknown>).clientPid;
  if (!Number.isInteger(pid) || Number(pid) <= 0) {
    throw new Error("A valid local inference client identity is required.");
  }
  return Number(pid);
}

function parsePin(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).pin === true,
  );
}

function pruneDeadLeases(leases: Map<number, LocalEngineProfile>): void {
  for (const pid of leases.keys()) {
    if (!isPidAlive(pid)) leases.delete(pid);
  }
}

function parseIllustrationRequest(value: unknown): {
  prompt: string;
  seeds: number[];
  outPaths: string[];
} {
  if (!value || typeof value !== "object")
    throw new Error("Invalid illustration request.");
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.prompt !== "string" ||
    !Array.isArray(raw.seeds) ||
    raw.seeds.some((seed) => !Number.isInteger(seed)) ||
    raw.seeds.length < 1 ||
    raw.seeds.length > 4 ||
    !Array.isArray(raw.outPaths) ||
    raw.outPaths.length !== raw.seeds.length ||
    raw.outPaths.some(
      (out) =>
        typeof out !== "string" || !path.isAbsolute(out) || !out.endsWith(".png"),
    )
  ) {
    throw new Error("Invalid illustration request.");
  }
  return {
    prompt: raw.prompt,
    seeds: raw.seeds as number[],
    outPaths: (raw.outPaths as string[]).map((out) => path.resolve(out)),
  };
}
