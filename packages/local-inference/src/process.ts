/**
 * The engine as an operating-system process: spawning it detached with its
 * output in a log, telling whether a PID is alive and is ours (by its
 * executable, so a recycled PID or a hand-started server is never touched),
 * finding servers a crashed host left behind, and stopping them.
 */
import { spawn } from "node:child_process";
import { open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";

export type CommandRunner = (
  command: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<void>;

/** Starts the engine detached, its output appended to `logPath`; resolves to its PID. */
export type SpawnServer = (
  command: string,
  args: string[],
  logPath: string,
) => Promise<number>;
/** Whether `pid` runs the executable at `serverPath`. */
export type OwnsPid = (pid: number, serverPath: string) => Promise<boolean>;
/** Finds live engine processes started from `serverPath` and bound to `port`. */
export type FindManagedPids = (serverPath: string, port: number) => Promise<number[]>;

export type ProcessControl = {
  isPidAlive: (pid: number) => boolean;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
};

/** SIGTERM, then SIGKILL if the process is still up after 10 seconds. */
export async function terminateProcess(
  pid: number,
  control: ProcessControl,
): Promise<void> {
  try {
    control.killPid(pid, "SIGTERM");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && control.isPidAlive(pid)) {
    await control.sleep(100);
  }
  if (control.isPidAlive(pid)) {
    try {
      control.killPid(pid, "SIGKILL");
    } catch (error) {
      if (!isMissingProcessError(error)) throw error;
    }
  }
}

export async function runCommand(
  command: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<void> {
  const executable = Bun.which(command) ?? command;
  const proc = Bun.spawn([executable, ...args], {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit ${code}`;
    throw new Error(`${command} failed: ${detail}`);
  }
}

/**
 * Variables that would make an engine log prompts or replies: llama-server's
 * LLAMA_ARG_* / LLAMA_LOG_* settings and slot debugging, and vLLM's.
 */
const ENGINE_LOGGING_VARIABLE = /^(LLAMA_ARG_|LLAMA_LOG|LLAMA_SERVER_|VLLM_)/;

/** The caller's environment minus anything that would log the Game Master's text. */
export function engineEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !ENGINE_LOGGING_VARIABLE.test(key) && key !== "NQ_CAPTURE_REQUESTS",
    ),
  );
}

/**
 * Runs `command` with a core-dump limit of zero, so a crash cannot write the
 * process's memory (prompts and replies) to disk. Linux and macOS only.
 */
export function withoutCoreDumps(command: string, args: string[]): [string, string[]] {
  if (process.platform === "win32") return [command, args];
  return ["/bin/sh", ["-c", 'ulimit -c 0 && exec "$@"', "sh", command, ...args]];
}

export async function spawnDetachedServer(
  command: string,
  args: string[],
  logPath: string,
): Promise<number> {
  const log = await open(logPath, "a");
  try {
    const [file, argv] = withoutCoreDumps(command, args);
    const child = spawn(file, argv, {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      windowsHide: true,
      env: engineEnvironment(process.env),
    });
    // a missing executable arrives as an `error` event (ENOENT), not a throw
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error(`${command} did not return a process id.`);
    child.unref();
    return child.pid;
  } finally {
    await log.close();
  }
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Linux appends " (deleted)" to /proc/<pid>/exe once the binary has been
 * replaced, which a rebuild does while the server is still running. Without
 * trimming it the path no longer resolves and we stop recognising our own
 * process, so a rebuild would strand the engine holding the GPU.
 */
async function resolveExePath(pid: number): Promise<string> {
  const DELETED = " (deleted)";
  let target = await readlink(`/proc/${pid}/exe`);
  if (target.endsWith(DELETED)) target = target.slice(0, -DELETED.length);
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

export async function defaultOwnsPid(
  pid: number,
  expectedServerPath: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const expected = await realpath(expectedServerPath);
    let actual: string;
    if (platform === "linux") {
      actual = await resolveExePath(pid);
    } else if (platform === "darwin") {
      const ps = Bun.which("ps") ?? "ps";
      const proc = Bun.spawn([ps, "-p", String(pid), "-o", "comm="], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = (await new Response(proc.stdout).text()).trim();
      if ((await proc.exited) !== 0 || !output) return false;
      actual = await realpath(output);
    } else if (platform === "win32") {
      const powershell = Bun.which("pwsh") ?? Bun.which("powershell.exe");
      if (!powershell) return false;
      const query = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ExecutablePath`;
      const proc = Bun.spawn(
        [powershell, "-NoProfile", "-NonInteractive", "-Command", query],
        { stdout: "pipe", stderr: "ignore" },
      );
      actual = (await new Response(proc.stdout).text()).trim();
      if ((await proc.exited) !== 0 || !actual) return false;
    } else {
      return false;
    }
    return platform === "win32"
      ? path.normalize(actual).toLowerCase() ===
          path.normalize(expected).toLowerCase()
      : actual === expected;
  } catch {
    return false;
  }
}

/**
 * Lists Atomic processes running `serverPath` with `--port <port>`. Matching on
 * both keeps a hand-started server from the same build out of the results.
 */
export async function defaultFindManagedPids(
  serverPath: string,
  port: number,
  platform: NodeJS.Platform,
): Promise<number[]> {
  const flag = `--port`;
  const wanted = String(port);

  if (platform === "linux") {
    const expected = await realpath(serverPath);
    const pids: number[] = [];
    for (const entry of await readdir("/proc")) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        const exe = await resolveExePath(pid);
        if (exe !== expected) continue;
        const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split(
          "\0",
        );
        if (
          argv.some(
            (value, index) => value === flag && argv[index + 1] === wanted,
          )
        ) {
          pids.push(pid);
        }
      } catch {
        // the process exited, or its /proc entry is not readable by us
      }
    }
    return pids;
  }

  if (platform === "darwin") {
    const ps = Bun.which("ps") ?? "ps";
    const proc = Bun.spawn([ps, "-A", "-o", "pid=,command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return [];
    const expected = await realpath(serverPath);
    const pids: number[] = [];
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const command = match[2] ?? "";
      if (!command.includes(expected) || !command.includes(`${flag} ${wanted}`))
        continue;
      pids.push(Number(match[1]));
    }
    return pids;
  }

  if (platform === "win32") {
    const powershell = Bun.which("pwsh") ?? Bun.which("powershell.exe");
    if (!powershell) return [];
    const query =
      "Get-CimInstance Win32_Process -Filter \"Name = 'llama-server.exe'\" | " +
      'ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }';
    const proc = Bun.spawn(
      [powershell, "-NoProfile", "-NonInteractive", "-Command", query],
      { stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return [];
    const expected = path.normalize(serverPath).toLowerCase();
    const pids: number[] = [];
    for (const line of output.split("\n")) {
      const [pid, exe, command] = line.trim().split("\t");
      if (!pid || !exe || !command) continue;
      if (path.normalize(exe).toLowerCase() !== expected) continue;
      if (!command.includes(`${flag} ${wanted}`)) continue;
      pids.push(Number(pid));
    }
    return pids;
  }

  return [];
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
