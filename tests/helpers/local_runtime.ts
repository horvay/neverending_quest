import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createLocalRuntimeManager,
  type LocalRuntimeManager,
} from "@nq/local-inference/runtime.ts";
import { writeGgufFixture } from "./gguf.ts";

/**
 * NQ's real local runtime manager over a fake engine process.
 *
 * The installation (`installation.json`, a GGUF model header, the server
 * binary path) is real and read back by the manager. Only the llama.cpp /
 * Atomic process is faked: "spawning" it starts a Bun.serve on the port the
 * manager chose, answering `/v1/models` so the manager sees it come up, and
 * handing every other request to `engine`. Killing it stops that server.
 */

export type FakeEngineHandler = (
  request: Request,
) => Response | Promise<Response>;

export type FakeLocalRuntime = {
  readonly runtime: LocalRuntimeManager;
  readonly rootDir: string;
  readonly alias: string;
  /**
   * Engine lifecycle as the process boundary saw it, oldest first:
   * `start:<port>:<alias>:<ctx>:<reasoning budget>` per spawn, `stop` per kill.
   */
  readonly events: string[];
  /** Full command lines the manager spawned, oldest first. */
  readonly spawns: string[][];
  running(): boolean;
  /** Stop the engine server if a test left it up. */
  shutdown(): void;
};

const FAKE_ENGINE_PID = 1_000_000_009;

export function reservePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

function argAfter(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1] ?? "";
}

export async function fakeLocalRuntime(opts: {
  rootDir: string;
  /** The engine port; also recorded as the installation's last port. */
  enginePort: number;
  alias?: string;
  engine?: FakeEngineHandler;
}): Promise<FakeLocalRuntime> {
  const { rootDir, enginePort } = opts;
  const alias = opts.alias ?? "local-test";
  const serverPath = path.join(rootDir, "runtime", "build", "bin", "llama-server");
  const modelPath = path.join(rootDir, "models", `${alias}.gguf`);
  await mkdir(path.dirname(serverPath), { recursive: true });
  await mkdir(path.dirname(modelPath), { recursive: true });
  await Bun.write(serverPath, "fake llama-server\n");
  await writeGgufFixture(modelPath, {
    architecture: "qwen3",
    values: { "qwen3.block_count": 4 },
  });
  await Bun.write(
    path.join(rootDir, "installation.json"),
    `${JSON.stringify(
      {
        schema: 2,
        runtime: {
          release: "test",
          target: {
            platform: "linux",
            arch: "x64",
            backend: "cpu",
            assetName: "llama-test.tar.gz",
          },
          root: path.join(rootDir, "runtime"),
          serverPath,
        },
        models: [
          {
            alias,
            source: modelPath,
            files: [
              { name: path.basename(modelPath), path: modelPath, external: true },
            ],
            primaryPath: modelPath,
          },
        ],
        defaultModel: alias,
        // keeps every status probe on this test's port, never 8080
        lastPort: enginePort,
      },
      null,
      2,
    )}\n`,
  );

  const events: string[] = [];
  const spawns: string[][] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  const runtime = createLocalRuntimeManager({
    rootDir,
    spawnServer: async (_command, args) => {
      spawns.push([...args]);
      const port = Number(argAfter(args, "--port"));
      events.push(
        `start:${port}:${argAfter(args, "-a")}:${argAfter(args, "-c")}:${argAfter(args, "--reasoning-budget")}`,
      );
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        idleTimeout: 0,
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/v1/models" || url.pathname === "/models") {
            return Response.json({ object: "list", data: [{ id: alias }] });
          }
          if (url.pathname === "/health") return Response.json({ status: "ok" });
          return opts.engine
            ? opts.engine(request)
            : new Response("Not found", { status: 404 });
        },
      });
      return FAKE_ENGINE_PID;
    },
    isPidAlive: (pid) => pid === FAKE_ENGINE_PID && server !== undefined,
    ownsPid: async (pid) => pid === FAKE_ENGINE_PID,
    findManagedPids: async () => (server ? [FAKE_ENGINE_PID] : []),
    killPid: (pid) => {
      if (pid !== FAKE_ENGINE_PID || !server) return;
      events.push("stop");
      server.stop(true);
      server = undefined;
    },
  });

  return {
    runtime,
    rootDir,
    alias,
    events,
    spawns,
    running: () => server !== undefined,
    shutdown: () => {
      server?.stop(true);
      server = undefined;
    },
  };
}
