import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, type Api } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
  createOmpAgentFactory,
  type OmpFactoryOptions,
} from "../../src/agent/omp/factory.ts";
import { prepareLocalGameMaster } from "../../src/home/index.ts";
import type { LocalEngineOptions } from "../../src/home/types.ts";
import type { AgentSessionFactory } from "../../src/play/types.ts";
import {
  createLocalInferenceHostClient,
  runLocalInferenceHostProcess,
  type LocalInferenceHostClient,
  type LocalInferenceHostStatus,
} from "@nq/local-inference/host.ts";
import {
  createLocalRuntimeManager,
  defaultLocalRuntimeDir,
} from "@nq/local-inference/runtime.ts";
import { LocalInferenceController } from "@nq/local-inference/inference.ts";
import type { LocalEngineProfileInput } from "@nq/local-inference/profile.ts";
import {
  EXL3XPU_IMAGE,
  EXL3XPU_PATCH_LEVEL,
  exl3xpuRoot,
} from "@nq/local-inference/engines/exl3xpu_image.ts";
import { makeTempDir, rmTempDir } from "./fs.ts";
import { writeGgufFixture, type GgufFixtureValue } from "./gguf.ts";
import type { AlmanacEntry } from "@nq/local-inference/almanac.ts";

/**
 * A real Local Inference Host over a fake engine.
 *
 * Everything NQ owns runs for real: the host process (in this process, on its
 * own temp root and ports), its control API and text proxy, the inference
 * controller, and the runtime manager with a real `installation.json` and GGUF
 * model file on disk. Only the llama.cpp / Atomic engine is faked: "spawning"
 * it starts a small Bun.serve on the engine port that speaks the parts of the
 * llama-server API the host uses (`/v1/models`, streamed
 * `/v1/chat/completions`, and its `/control` reasoning cutoff).
 *
 * `gameMaster()` builds the real Game Master for this host: our OMP adapter
 * over OMP's own OpenAI-compatible llama.cpp client, pointed at the host's
 * public endpoint. A Turn then crosses every real layer down to the engine.
 */

export type FakeEngineOptions = {
  /** Reasoning the engine streams first. */
  reasoning?: string;
  /** Answer the engine streams once reasoning ends. */
  reply?: string;
  /**
   * Keep the reasoning block open until the host sends `reasoning_end`
   * (default). When false the engine streams reasoning and reply at once.
   */
  holdReasoning?: boolean;
  /**
   * While pending, the engine is still loading its model: like llama-server,
   * it answers `/v1/models` with 503, so the host keeps waiting for it.
   */
  loading?: Promise<void>;
};

export type FakeEngine = {
  readonly port: number;
  /** Command lines the runtime manager "spawned", newest last. */
  readonly spawns: string[][];
  /** The server binary each spawn ran, in step with `spawns`. */
  readonly commands: string[];
  /** Chat completion bodies that reached the engine, oldest first. */
  readonly completions: Array<Record<string, unknown>>;
  /** Reasoning control requests that reached the engine, oldest first. */
  readonly controls: Array<{ path: string; body: Record<string, unknown> }>;
  running(): boolean;
};

export type LocalHost = {
  /** The host's root (what `XDG_DATA_HOME/nq/local` would be). */
  readonly rootDir: string;
  /** Installed model alias; `llama.cpp/<alias>` in NQ config terms. */
  readonly alias: string;
  readonly engine: FakeEngine;
  /** A real host client for this root, leasing as this process. */
  readonly client: LocalInferenceHostClient;
  /** The host's public OpenAI-compatible endpoint. */
  endpoint(): Promise<string>;
  /** Lease the Game Master model, which starts the (fake) engine. */
  activate(): Promise<LocalInferenceHostStatus>;
  /** The CLI's reasoning cutoff wiring, pointed at this host. */
  endReasoning(): Promise<boolean>;
  /**
   * The CLI's `prepareModel` wiring (HomeSurface warms a local model before
   * a Campaign opens), pointed at this host.
   */
  prepareModel(
    model: string | undefined,
    opts: {
      signal: AbortSignal;
      onProgress: (message: string) => void;
      reasoning?: string;
      almanac?: readonly AlmanacEntry[];
    } & Partial<LocalEngineOptions>,
  ): Promise<void>;
  /**
   * The real Game Master for `llama.cpp/<alias>`: our OMP adapter over OMP's
   * llama.cpp (OpenAI-compatible) client, talking to this host's endpoint.
   */
  gameMaster(
    opts?: Omit<OmpFactoryOptions, "connection" | "model">,
    registration?: {
      /**
       * Register the model as OMP's llama.cpp discovery does on a real
       * machine: the Responses API, and not marked as a reasoner.
       */
      discovered?: boolean;
      /** The output ceiling OMP asks for (default 4096). */
      maxTokens?: number;
    },
  ): Promise<AgentSessionFactory>;
  /** Stop the host (and so the engine) and remove its root. */
  stop(): Promise<void>;
};

const FAKE_ENGINE_PID = 1_000_000_007;

function reservePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function waitForFile(target: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(target).exists()) return;
    await Bun.sleep(2);
  }
  throw new Error(`Timed out waiting for ${target}`);
}

function sse(value: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

/**
 * An EXL3 model folder as exllamav3 writes one for a Gemma 4 model, plus the
 * assistant model that drafts for it. The weights themselves never load: the
 * engine is faked, so the config files are all NQ reads.
 */
export async function writeExl3Fixture(
  directory: string,
  opts: { drafter?: string } = {},
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const json = (name: string, value: unknown) =>
    Bun.write(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
  await json("config.json", {
    architectures: ["Gemma4ForConditionalGeneration"],
    model_type: "gemma4",
    tie_word_embeddings: true,
    text_config: { hidden_size: 5376, vocab_size: 262144, model_type: "gemma4_text" },
  });
  await json("quantization_config.json", {
    quant_method: "exl3",
    bits: 4.0,
    head_bits: 16,
    codebook: "mul1",
  });
  await json("generation_config.json", { temperature: 1.0, top_k: 64, top_p: 0.95 });
  // the switches Gemma 4's own template reads
  await Bun.write(
    path.join(directory, "chat_template.jinja"),
    "{%- set enable_thinking = enable_thinking | default(false) -%}{%- set preserve_thinking = preserve_thinking | default(false) -%}{{ bos_token }}\n",
  );
  await Bun.write(
    path.join(directory, "README.md"),
    "---\nbase_model:\n- google/gemma-4-31B-it\n---\n# A merge\n",
  );
  await Bun.write(path.join(directory, "model-00001-of-00001.safetensors"), "weights");
  if (opts.drafter) {
    await mkdir(opts.drafter, { recursive: true });
    await Bun.write(
      path.join(opts.drafter, "config.json"),
      JSON.stringify({
        model_type: "gemma4_assistant",
        backbone_hidden_size: 5376,
        text_config: { hidden_size: 1024, vocab_size: 262144 },
      }),
    );
  }
}

/** Marks the exl3xpu engine installed, as a finished `nq local install --engine exl3xpu` does. */
export async function markExl3xpuInstalled(rootDir: string): Promise<void> {
  const root = exl3xpuRoot(rootDir);
  await mkdir(path.join(root, "rootfs"), { recursive: true });
  await Bun.write(
    path.join(root, "engine.json"),
    `${JSON.stringify({ digest: EXL3XPU_IMAGE.digest, patchLevel: EXL3XPU_PATCH_LEVEL })}\n`,
  );
}

/**
 * vLLM as exl3xpu runs it, for the host's side of the wire: reasoning streams
 * as `delta.reasoning`, there is no /control, and a prompt whose thinking
 * prefill is already closed gets the answer straight away. Otherwise the
 * engine thinks until the request is aborted (unless `holdReasoning: false`).
 */
function fakeVllmServer(
  port: number,
  alias: string,
  opts: FakeEngineOptions,
  state: {
    completions: FakeEngine["completions"];
    controls: FakeEngine["controls"];
  },
  maxModelLen: number,
): ReturnType<typeof Bun.serve> {
  let seq = 0;
  // one token per 4 characters of what the template would render
  const promptTokens = (body: Record<string, unknown>) => {
    const kwargs = (body.chat_template_kwargs ?? {}) as Record<string, unknown>;
    const text = JSON.stringify(body.messages ?? []) + JSON.stringify(body.tools ?? []) + String(kwargs.nq_prefill ?? "");
    return Math.ceil(text.length / 4);
  };
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: alias }] });
      }
      if (url.pathname === "/health") return new Response(null, { status: 200 });
      if (url.pathname === "/tokenize" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        return Response.json({ count: promptTokens(body), max_model_len: maxModelLen, tokens: [] });
      }
      if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        state.completions.push(body);
        // vLLM serves one model name (--served-model-name) and refuses any other
        if (body.model !== alias) {
          return Response.json(
            { error: { message: `The model \`${String(body.model)}\` does not exist.`, type: "NotFoundError", code: 404 } },
            { status: 404 },
          );
        }
        // vLLM refuses a request whose prompt plus output budget exceeds the context
        const budget = Number(body.max_tokens ?? body.max_completion_tokens ?? 0);
        if (promptTokens(body) + budget > maxModelLen) {
          return Response.json(
            { error: { message: "This model's maximum context length is exceeded.", code: 400 } },
            { status: 400 },
          );
        }
        seq += 1;
        const id = `chatcmpl-vllm-${seq}`;
        const kwargs = (body.chat_template_kwargs ?? {}) as Record<string, unknown>;
        const closed =
          typeof kwargs.nq_prefill === "string" && kwargs.nq_prefill.includes("<channel|>");
        const chunk = (delta: Record<string, unknown>, finish?: string) =>
          sse({
            id,
            object: "chat.completion.chunk",
            model: alias,
            choices: [{ index: 0, delta, finish_reason: finish ?? null }],
          });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const answer = () => {
                controller.enqueue(chunk({ content: opts.reply ?? "The tide turns." }));
                controller.enqueue(chunk({}, "stop"));
                controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                controller.close();
              };
              controller.enqueue(chunk({ role: "assistant", content: "" }));
              if (closed) return answer();
              controller.enqueue(
                chunk({ reasoning: opts.reasoning ?? "Weighing the tide tables." }),
              );
              if (opts.holdReasoning === false) return answer();
              // thinks on until the host aborts the request
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.pathname.endsWith("/control")) {
        state.controls.push({ path: url.pathname, body: {} });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}

/**
 * An Atomic server binary as far as `--list-devices` goes: the one engine
 * command NQ runs to completion rather than spawning as a server.
 */
export async function writeDeviceScript(
  serverPath: string,
  devices: string,
): Promise<void> {
  await mkdir(path.dirname(serverPath), { recursive: true });
  // beside the script, so a release archive of it still works once extracted
  await Bun.write(path.join(path.dirname(serverPath), "devices.txt"), devices);
  await Bun.write(
    serverPath,
    '#!/bin/sh\n[ "$1" = "--list-devices" ] && cat "$(dirname "$0")/devices.txt"\nexit 0\n',
  );
  await chmod(serverPath, 0o755);
}

type OpenCompletion = { id: string; endReasoning: () => void };

function fakeEngineServer(
  port: number,
  alias: string,
  opts: FakeEngineOptions,
  state: {
    completions: FakeEngine["completions"];
    controls: FakeEngine["controls"];
  },
): ReturnType<typeof Bun.serve> {
  const open = new Map<string, OpenCompletion>();
  let seq = 0;
  let loaded = !opts.loading;
  void opts.loading?.then(() => {
    loaded = true;
  });
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        if (!loaded) {
          return Response.json(
            { error: { code: 503, message: "Loading model" } },
            { status: 503 },
          );
        }
        return Response.json({ object: "list", data: [{ id: alias }] });
      }
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      if (
        url.pathname === "/v1/chat/completions" &&
        request.method === "POST"
      ) {
        const body = (await request.json()) as Record<string, unknown>;
        state.completions.push(body);
        seq += 1;
        const id = `chatcmpl-fake-${seq}`;
        const chunk = (delta: Record<string, unknown>, finish?: string) =>
          sse({
            id,
            object: "chat.completion.chunk",
            model: alias,
            choices: [
              { index: 0, delta, finish_reason: finish ?? null },
            ],
          });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              let done = false;
              const finish = () => {
                if (done) return;
                done = true;
                open.delete(id);
                controller.enqueue(
                  chunk({ content: opts.reply ?? "The tide turns." }),
                );
                controller.enqueue(chunk({}, "stop"));
                controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                controller.close();
              };
              controller.enqueue(
                chunk({
                  role: "assistant",
                  reasoning_content:
                    opts.reasoning ?? "Weighing the tide tables.",
                }),
              );
              if (opts.holdReasoning === false) return finish();
              open.set(id, { id, endReasoning: finish });
              request.signal.addEventListener(
                "abort",
                () => {
                  if (done) return;
                  done = true;
                  open.delete(id);
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (
        url.pathname === "/v1/chat/completions/control" &&
        request.method === "POST"
      ) {
        const body = (await request.json()) as Record<string, unknown>;
        state.controls.push({ path: url.pathname, body });
        const target = open.get(String(body.id));
        if (!target || body.action !== "reasoning_end") {
          return Response.json({
            success: false,
            message: "No such reasoning block.",
          });
        }
        // the engine closes the think block and moves on to the answer
        queueMicrotask(target.endReasoning);
        return Response.json({ success: true });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}

/** Start a real Local Inference Host whose engine is a fake llama-server. */
export async function startLocalHost(
  opts: {
    alias?: string;
    engine?: FakeEngineOptions;
    /**
     * Install into NQ's default local root (inside the test sandbox's
     * XDG_DATA_HOME) instead of a private temp dir, so code that finds the
     * local runtime on its own (Home's "This computer" probe, the model
     * list) sees this installation and this engine.
     */
    defaultRoot?: boolean;
    /** GGUF `general.architecture` of the installed model (default qwen3). */
    architecture?: string;
    /** GGUF `tokenizer.chat_template` of the installed model (default none). */
    chatTemplate?: string;
    /** More GGUF header values: `general.name`, `general.sampling.*`, … */
    metadata?: Record<string, GgufFixtureValue>;
    /** The installed build (default cpu). */
    backend?: string;
    /**
     * Serve the model as an EXL3 folder on the exl3xpu engine (installed),
     * with a drafter beside it, instead of a GGUF on Atomic.
     */
    exl3?: boolean;
    /**
     * What the installed server prints for `--list-devices`. When set, the
     * server on disk is a script that prints it, so NQ lists the cards by
     * running the build as it would a real one.
     */
    devices?: string;
    /**
     * A host that was killed mid-session before this one: it had started the
     * engine with this profile, and the engine and the host's state on disk
     * outlived it. The new host starts over that.
     */
    leftRunning?: LocalEngineProfileInput;
    /** With `leftRunning`: the engine died with that host. */
    engineExited?: boolean;
  } = {},
): Promise<LocalHost> {
  const rootDir = opts.defaultRoot
    ? defaultLocalRuntimeDir()
    : await makeTempDir("nq-local-host-");
  if (opts.defaultRoot) await mkdir(rootDir, { recursive: true });
  const alias = opts.alias ?? "story-model";
  const enginePort = reservePort();
  const spawns: string[][] = [];
  const commands: string[] = [];
  const completions: FakeEngine["completions"] = [];
  const controls: FakeEngine["controls"] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;

  // a real installation on disk: the runtime manager reads and validates it
  const serverPath = path.join(rootDir, "runtime", "build", "bin", "llama-server");
  const modelPath = path.join(rootDir, "models", `${alias}.gguf`);
  await mkdir(path.dirname(serverPath), { recursive: true });
  await mkdir(path.dirname(modelPath), { recursive: true });
  if (opts.devices === undefined) {
    await Bun.write(serverPath, "fake llama-server\n");
  } else {
    await writeDeviceScript(serverPath, opts.devices);
  }
  if (opts.exl3) {
    await writeExl3Fixture(path.join(rootDir, "models", alias), {
      drafter: path.join(rootDir, "models", `${alias}-assistant`),
    });
    await markExl3xpuInstalled(rootDir);
  }
  const architecture = opts.architecture ?? "qwen3";
  if (!opts.exl3) await writeGgufFixture(modelPath, {
    architecture,
    values: {
      [`${architecture}.block_count`]: 4,
      ...(opts.chatTemplate ? { "tokenizer.chat_template": opts.chatTemplate } : {}),
      ...opts.metadata,
    },
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
            backend: opts.backend ?? "cpu",
            assetName: "llama-test.tar.gz",
          },
          root: path.join(rootDir, "runtime"),
          serverPath,
        },
        // an EXL3 folder is found by the model scan, never registered
        models: opts.exl3
          ? []
          : [
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
        // status probes go to the fake engine's port, never a default one
        // (127.0.0.1:8080) where a real llama-server may be listening
        lastPort: enginePort,
      },
      null,
      2,
    )}\n`,
  );

  // the engine process boundary is the only thing faked
  const runtime = createLocalRuntimeManager({
    rootDir,
    spawnServer: async (command, args) => {
      spawns.push([...args]);
      commands.push(command);
      const port = Number(args[args.indexOf("--port") + 1]);
      server = args.includes("/opt/venv/bin/vllm")
        ? fakeVllmServer(
            port,
            args[args.indexOf("--served-model-name") + 1]!,
            opts.engine ?? {},
            { completions, controls },
            Number(args[args.indexOf("--max-model-len") + 1]),
          )
        : fakeEngineServer(port, alias, opts.engine ?? {}, { completions, controls });
      return FAKE_ENGINE_PID;
    },
    isPidAlive: (pid) => pid === FAKE_ENGINE_PID && server !== undefined,
    ownsPid: async (pid) => pid === FAKE_ENGINE_PID,
    findManagedPids: async () => (server ? [FAKE_ENGINE_PID] : []),
    killPid: (pid) => {
      if (pid !== FAKE_ENGINE_PID) return;
      server?.stop(true);
      server = undefined;
    },
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
  });

  if (opts.leftRunning) {
    // the earlier host's controller, abandoned without closing, as a killed
    // process leaves it: engine up, run record and inference state on disk
    const earlier = await LocalInferenceController.open({ runtime, enginePort });
    await earlier.activate({ model: alias, ...opts.leftRunning });
    if (opts.engineExited) {
      server?.stop(true);
      server = undefined;
    }
  }

  const running = runLocalInferenceHostProcess({
    rootDir,
    port: 0,
    enginePort,
    token: `test-${crypto.randomUUID()}`,
    runtime,
  });
  const recordPath = path.join(rootDir, "inference-host.json");
  await Promise.race([
    waitForFile(recordPath),
    running.then(() => {
      throw new Error("Local inference host exited during startup.");
    }),
  ]);

  const client = createLocalInferenceHostClient({
    rootDir,
    enginePort,
    clientPid: process.pid,
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
  });
  const endpoint = async () => {
    const record = JSON.parse(await Bun.file(recordPath).text()) as {
      port: number;
    };
    return `http://127.0.0.1:${record.port}`;
  };

  return {
    rootDir,
    alias,
    engine: {
      port: enginePort,
      spawns,
      commands,
      completions,
      controls,
      running: () => server !== undefined,
    },
    client,
    endpoint,
    activate: () => client.activate({ model: alias }),
    // same expression src/cli.ts hands HomeSurface, on this host's root
    endReasoning: async () => (await client.endReasoning()).success,
    // src/cli.ts prepareModelRuntime, on this host's root
    prepareModel: (model, opts) => prepareLocalGameMaster(client, model, opts),
    async gameMaster(factoryOpts = {}, registration = {}) {
      // how OMP registers a llama.cpp provider; the key is unused locally
      const auth = await AuthStorage.create(":memory:");
      const modelRegistry = new ModelRegistry(auth);
      const discovered = registration.discovered === true;
      modelRegistry.registerProvider("llama.cpp", {
        baseUrl: discovered ? await endpoint() : `${await endpoint()}/v1`,
        api: (discovered ? "openai-responses" : "openai-completions") as Api,
        apiKey: "none",
        models: [
          {
            id: alias,
            name: alias,
            reasoning: !discovered,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 65_536,
            maxTokens: registration.maxTokens ?? 4_096,
          },
        ],
      });
      const model = modelRegistry.find("llama.cpp", alias);
      if (!model) throw new Error(`OMP did not register llama.cpp/${alias}`);
      return createOmpAgentFactory({
        ...factoryOpts,
        connection: { model, modelRegistry },
      });
    },
    async stop() {
      try {
        await client.stop();
        await running;
      } finally {
        server?.stop(true);
        server = undefined;
        await rmTempDir(rootDir);
      }
    },
  };
}
