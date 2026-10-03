import { main, type MainOptions } from "../../src/cli.ts";
import type { AgentSessionFactory } from "../../src/play/types.ts";

export type CliResult = { stdout: string; stderr: string; code: number };

export type CliOptions = {
  /** Environment overrides for this run; restored afterwards. */
  env?: Record<string, string>;
  /** Stops a long-running command such as `serve`. */
  signal?: AbortSignal;
  /** The Game Master the command plays with (e.g. `scriptedGameMaster().factory`). */
  factory?: AgentSessionFactory;
};

type Captured = { out: string[]; err: string[]; restore: () => void };

function text(args: unknown[]): string {
  return `${args
    .map((a) => (typeof a === "string" ? a : Bun.inspect(a)))
    .join(" ")}\n`;
}

function chunk(value: unknown): string {
  return typeof value === "string"
    ? value
    : new TextDecoder().decode(value as Uint8Array);
}

/**
 * Point the process at a non-interactive terminal, apply env overrides, and
 * collect everything the CLI prints. Returns a restore function.
 */
function capture(env: Record<string, string>): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const saved = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    outWrite: process.stdout.write,
    errWrite: process.stderr.write,
    stdinTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    stdoutTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
  };
  const priorEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    priorEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  console.log = (...args: unknown[]) => void out.push(text(args));
  console.info = console.log;
  console.debug = console.log;
  console.error = (...args: unknown[]) => void err.push(text(args));
  console.warn = console.error;
  process.stdout.write = ((value: unknown) => {
    out.push(chunk(value));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((value: unknown) => {
    err.push(chunk(value));
    return true;
  }) as typeof process.stderr.write;
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    configurable: true,
  });

  const restoreTTY = (
    stream: NodeJS.ReadStream | NodeJS.WriteStream,
    desc: PropertyDescriptor | undefined,
  ) => {
    if (desc) Object.defineProperty(stream, "isTTY", desc);
    else delete (stream as { isTTY?: boolean }).isTTY;
  };

  return {
    out,
    err,
    restore() {
      console.log = saved.log;
      console.info = saved.info;
      console.warn = saved.warn;
      console.error = saved.error;
      console.debug = saved.debug;
      process.stdout.write = saved.outWrite;
      process.stderr.write = saved.errWrite;
      restoreTTY(process.stdin, saved.stdinTTY);
      restoreTTY(process.stdout, saved.stdoutTTY);
      for (const [key, value] of priorEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/**
 * Run the real `nq` CLI in this process: same argument parsing, commands and
 * Campaign I/O as the binary, without paying for a new Bun process per call.
 * External dependencies stay faked by the test preload.
 */
export async function runCli(
  args: string[],
  opts: CliOptions = {},
): Promise<CliResult> {
  const io = capture(opts.env ?? {});
  try {
    const mainOpts: MainOptions = {};
    if (opts.signal) mainOpts.signal = opts.signal;
    if (opts.factory) mainOpts.agentFactory = opts.factory;
    const code = await main(["bun", "src/cli.ts", ...args], mainOpts);
    return { code, stdout: io.out.join(""), stderr: io.err.join("") };
  } catch (err) {
    io.err.push(`${err instanceof Error ? err.message : String(err)}\n`);
    return { code: 1, stdout: io.out.join(""), stderr: io.err.join("") };
  } finally {
    io.restore();
  }
}

/** A long-running command (`nq serve`) started in-process. */
export type RunningCli = {
  /** Settles when the command returns on its own (usually a startup error). */
  readonly done: Promise<CliResult>;
  /** Whether the command has returned. */
  exited(): boolean;
  /** Stop the command and wait for it to return. */
  stop(): Promise<CliResult>;
};

export function startCli(args: string[], opts: CliOptions = {}): RunningCli {
  const controller = new AbortController();
  let finished = false;
  const done = runCli(args, { ...opts, signal: controller.signal }).finally(
    () => {
      finished = true;
    },
  );
  return {
    done,
    exited: () => finished,
    async stop() {
      controller.abort();
      return done;
    },
  };
}

export function freePort(): number {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Wait until something accepts connections on `port`, or the command exits. */
export async function waitForListen(
  port: number,
  running: RunningCli,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (running.exited()) {
      const result = await running.done;
      throw new Error(
        `nq serve exited ${result.code} before it was reachable: ${result.stderr}`,
      );
    }
    try {
      await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open(socket) {
            socket.end();
          },
          close() {},
          error() {},
        },
      });
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error("nq serve did not become reachable");
}
