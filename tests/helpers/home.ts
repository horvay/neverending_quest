import { mkdir, rm, truncate } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, type Api } from "@oh-my-pi/pi-ai";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import {
  ModelRegistry,
  type ProviderConfigInput,
} from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createHomeAuth } from "../../src/home/auth.ts";
import type { HomeAuth } from "../../src/home/types.ts";
import { defaultLocalRuntimeDir } from "@nq/local-inference/runtime.ts";
import { writeGgufFixture, type GgufFixtureValue } from "./gguf.ts";

/**
 * Home's sign-in over a real OMP auth store with a fake Provider.
 *
 * Only the Provider is faked: it is registered the way an OMP extension
 * registers one (an OAuth-style login plus a model catalog), so OMP's
 * `AuthStorage.login`, its credential store, and its `ModelRegistry` run for
 * real, and so does every line of NQ's Home adapter above them (player copy,
 * Provider naming, model naming, thinking levels, the local model listing).
 * Nothing reaches the network: the login is scripted and the registry refuses
 * to fetch under `bun test`.
 */

export type FakeProviderModel = {
  id: string;
  name: string;
  /** Thinking efforts the model offers; omit for a non-reasoning model. */
  efforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
};

export type FakeProviderLogin = {
  /** Where the Provider asks the player to sign in. */
  url?: string;
  instructions?: string;
  /** What the Provider asks the player to paste; omit to sign in without one. */
  prompt?: string;
  /** Progress the Provider reports after the paste. */
  progress?: string;
  /** Fail the sign-in with this message instead of returning a key. */
  fail?: string;
};

export type FakeProvider = {
  readonly id: string;
  readonly registry: ModelRegistry;
  readonly storage: AuthStorage;
  /** NQ's real Home auth adapter over this registry. */
  readonly auth: HomeAuth;
  /** Keys the Provider handed back, one per completed sign-in. */
  readonly signIns: string[];
  /** Everything the fake Provider showed the player, as OMP passed it on. */
  readonly seen: { prompts: string[]; auth: Array<{ url?: string }> };
  /** Store a credential as if the player had signed in on an earlier day. */
  connect(): Promise<void>;
  /** Unregister the Provider from OMP's global OAuth list. */
  dispose(): void;
};

let providerSeq = 0;

export async function fakeProvider(
  opts: {
    /** Display name OMP lists; NQ cleans it ("(API)" etc. dropped). */
    name?: string;
    models?: FakeProviderModel[];
    login?: FakeProviderLogin;
  } = {},
): Promise<FakeProvider> {
  providerSeq += 1;
  // letters only, so a model search for "2" can't match the provider id
  const id = `lanternlight-${providerSeq.toString(26).replace(/\d/g, (d) => "qrstuvwxyz"[Number(d)]!)}`;
  const sourceId = `nq-tests/${id}`;
  const storage = await AuthStorage.create(":memory:");
  const registry = new ModelRegistry(storage);
  const signIns: string[] = [];
  const seen: FakeProvider["seen"] = { prompts: [], auth: [] };
  const login = opts.login ?? {
    url: "https://lanternlight.test/sign-in",
    instructions: "A browser window should have opened.",
    prompt: "Paste your API key",
    progress: "Validating API key…",
  };
  const models = opts.models ?? [
    {
      id: "lamp-2",
      name: "Lamp 2",
      efforts: ["low", "medium", "high", "xhigh"],
    },
    { id: "lamp-1", name: "Lamp 1" },
  ];
  registry.registerProvider(
    id,
    {
      // never dialed: the Game Master under test is scripted
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions" as Api,
      oauth: {
        name: opts.name ?? "Lanternlight (API)",
        async login(callbacks) {
          if (login.url) {
            seen.auth.push({ url: login.url });
            callbacks.onAuth?.({
              url: login.url,
              ...(login.instructions
                ? { instructions: login.instructions }
                : {}),
            });
          }
          let key = "lantern-key";
          if (login.prompt) {
            seen.prompts.push(login.prompt);
            key = await callbacks.onPrompt!({ message: login.prompt });
          }
          if (login.progress) callbacks.onProgress?.(login.progress);
          if (login.fail) throw new Error(login.fail);
          signIns.push(key);
          return key || "lantern-key";
        },
      },
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: Boolean(m.efforts?.length),
        ...(m.efforts?.length
          ? { thinking: { mode: "effort" as const, efforts: m.efforts } }
          : {}),
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      })) as NonNullable<ProviderConfigInput["models"]>,
    },
    sourceId,
  );
  return {
    id,
    registry,
    storage,
    auth: createHomeAuth({ registry }),
    signIns,
    seen,
    async connect() {
      await storage.set(id, { type: "api_key", key: "earlier-key" } as never);
    },
    dispose() {
      unregisterOAuthProviders(sourceId);
      storage.close();
    },
  };
}

export type LocalModelFile = {
  alias: string;
  /** File name on disk; the Home lists it without `.gguf`. */
  file?: string;
  /** Stretch the (sparse) file to this many bytes so the picker shows a size. */
  size?: number;
  /** Extra GGUF metadata, such as the model's `general.sampling.*` defaults. */
  metadata?: Record<string, GgufFixtureValue>;
  /** GGUF `general.architecture` (default qwen3). */
  architecture?: string;
};

export type LocalInstall = {
  readonly rootDir: string;
  readonly modelsDir: string;
  /** Replace the installed models (an empty list: runtime without models). */
  setModels(models: LocalModelFile[]): Promise<void>;
  /** Put a projector file next to the models. Returns its path. */
  addProjector(name: string): Promise<string>;
  remove(): Promise<void>;
};

function closedPort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/**
 * A real local runtime installation where NQ looks for one (the sandboxed
 * `XDG_DATA_HOME/nq/local`), with small GGUF model files. The engine is never
 * started. Its last port points at a closed one, so NQ's status probe can
 * never reach a llama-server running on this machine (with no installation at
 * all, NQ would probe the default port 8080).
 *
 * NQ also scans `./models` under the working directory, so this runs the
 * process from an empty directory until `remove()`.
 */
export async function installLocalModels(
  models: LocalModelFile[] = [],
): Promise<LocalInstall> {
  const rootDir = defaultLocalRuntimeDir();
  const modelsDir = path.join(rootDir, "models");
  const serverPath = path.join(
    rootDir,
    "runtime",
    "build",
    "bin",
    "llama-server",
  );
  const priorCwd = process.cwd();
  const cwd = path.join(rootDir, "cwd");
  await mkdir(cwd, { recursive: true });
  process.chdir(cwd);
  await mkdir(path.dirname(serverPath), { recursive: true });
  await mkdir(modelsDir, { recursive: true });
  await Bun.write(serverPath, "fake llama-server\n");
  const lastPort = closedPort();

  const setModels = async (list: LocalModelFile[]) => {
    await rm(modelsDir, { recursive: true, force: true });
    await mkdir(modelsDir, { recursive: true });
    const entries = [];
    for (const model of list) {
      const primaryPath = path.join(
        modelsDir,
        model.file ?? `${model.alias}.gguf`,
      );
      const architecture = model.architecture ?? "qwen3";
      await writeGgufFixture(primaryPath, {
        architecture,
        values: { [`${architecture}.block_count`]: 4, ...model.metadata },
      });
      // sparse: a "12 GiB" model costs no disk
      if (model.size) await truncate(primaryPath, model.size);
      const size = Bun.file(primaryPath).size;
      entries.push({
        alias: model.alias,
        source: primaryPath,
        files: [
          {
            name: path.basename(primaryPath),
            path: primaryPath,
            external: false,
            size,
          },
        ],
        primaryPath,
      });
    }
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
          models: entries,
          ...(list[0] ? { defaultModel: list[0].alias } : {}),
          lastPort,
        },
        null,
        2,
      )}\n`,
    );
  };
  await setModels(models);

  return {
    rootDir,
    modelsDir,
    setModels,
    async addProjector(name) {
      const file = path.join(modelsDir, name);
      await writeGgufFixture(file, { architecture: "clip" });
      return file;
    },
    async remove() {
      process.chdir(priorCwd);
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}
