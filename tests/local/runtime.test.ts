import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  createLocalRuntimeManager,
  type LocalFetch,
} from "@nq/local-inference/index.ts";
import { makeTempDir, pathExists, rmTempDir } from "../helpers/fs.ts";
import { writeGgufFixture } from "../helpers/gguf.ts";
import { writeDeviceScript } from "../helpers/local_host.ts";

const ARCHIVE_BYTES = new TextEncoder().encode("atomic archive fixture");
const ARCHIVE_SHA = new Bun.CryptoHasher("sha256").update(ARCHIVE_BYTES).digest("hex");
const MODEL_BYTES = new TextEncoder().encode("downloaded model fixture");
const MODEL_SHA = new Bun.CryptoHasher("sha256").update(MODEL_BYTES).digest("hex");

type RuntimeFixture = {
  fetch: LocalFetch;
  runCommand: (command: string, args: string[]) => Promise<void>;
  spawnServer: (command: string, args: string[], logPath: string) => Promise<number>;
  isPidAlive: (pid: number) => boolean;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  serving: () => boolean;
  spawned: { command?: string; args?: string[]; logPath?: string };
};

function createRuntimeFixture(assetSha = ARCHIVE_SHA): RuntimeFixture {
  let serving = false;
  const spawned: RuntimeFixture["spawned"] = {};
  const fetch: LocalFetch = async (input) => {
    const url = String(input);
    if (url.includes("api.github.com/repos/AtomicBot-ai/")) {
      return Response.json({
        assets: [{
          name: "llama-turboquant-linux-x64-cpu.tar.gz",
          browser_download_url: "https://downloads.example/atomic.tar.gz",
          digest: `sha256:${assetSha}`,
          size: ARCHIVE_BYTES.byteLength,
        }],
      });
    }
    if (url === "https://downloads.example/atomic.tar.gz") {
      return new Response(ARCHIVE_BYTES);
    }
    if (
      url === "https://downloads.example/first.gguf" ||
      url === "https://downloads.example/second.gguf"
    ) {
      return new Response(MODEL_BYTES);
    }
    if (url.endsWith("/v1/models")) {
      if (!serving) throw new TypeError("Server is not listening.");
      return Response.json({ data: [{ id: "story-model" }] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return {
    fetch,
    async runCommand(command, args) {
      expect(command).toBe("tar");
      const destination = args[args.indexOf("-C") + 1]!;
      const bin = path.join(destination, "build", "bin");
      await mkdir(bin, { recursive: true });
      await Bun.write(path.join(bin, "llama-server"), "server fixture");
    },
    async spawnServer(command, args, logPath) {
      spawned.command = command;
      spawned.args = [...args];
      spawned.logPath = logPath;
      serving = true;
      return 4242;
    },
    isPidAlive(pid) {
      return pid === 4242 && serving;
    },
    killPid(pid) {
      expect(pid).toBe(4242);
      serving = false;
    },
    serving: () => serving,
    spawned,
  };
}

describe("NQ-managed Atomic runtime", () => {
  test("installs a verified runtime, starts the configured model, and stops it", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    try {
      const model = path.join(root, "story-model-MTP-APEX-I-Compact.gguf");
      await writeGgufFixture(model, {
        architecture: "qwen35",
        values: { "qwen35.block_count": 65, "qwen35.nextn_predict_layers": 1 },
      });
      const manager = createLocalRuntimeManager({
        rootDir: path.join(root, "local"),
        platform: "linux",
        arch: "x64",
        hardware: { rocm: false, vulkan: false },
        fetch: fixture.fetch,
        runCommand: fixture.runCommand,
        spawnServer: fixture.spawnServer,
        isPidAlive: fixture.isPidAlive,
        ownsPid: async () => true,
        killPid: fixture.killPid,
        sleep: async () => {},
      });

      const installation = await manager.install({ backend: "cpu", model: { source: model } });
      expect(installation.runtime.target.backend).toBe("cpu");
      expect(installation.models[0]?.primaryPath).toBe(model);
      expect(await pathExists(root, "local/installation.json")).toBe(true);

      const running = await manager.start({ port: 18_080, contextTokens: 32_768 });
      expect(running.state).toBe("running");
      expect(running.models).toEqual(["story-model"]);
      expect(fixture.spawned.command).toBe(installation.runtime.serverPath);
      expect(fixture.spawned.args).toContain("32768");
      expect(fixture.spawned.args).toContain("300");
      expect(fixture.spawned.args).toContain("story-model-mtp-apex-i-compact");
      expect(fixture.spawned.args).toContain("draft-mtp");
      expect(running.speculative).toContain("nextn_predict_layers = 1");
      const cacheK = fixture.spawned.args!.indexOf("-ctk");
      const cacheV = fixture.spawned.args!.indexOf("-ctv");
      expect(fixture.spawned.args![cacheK + 1]).toBe("q8_0");
      expect(fixture.spawned.args![cacheV + 1]).toBe("turbo3");
      // the MTP draft's KV cache follows the target's types instead of Atomic's f16 default
      const draftK = fixture.spawned.args!.indexOf("-ctkd");
      const draftV = fixture.spawned.args!.indexOf("-ctvd");
      expect(fixture.spawned.args![draftK + 1]).toBe("q8_0");
      expect(fixture.spawned.args![draftV + 1]).toBe("turbo3");
      const checkpoints = fixture.spawned.args!.indexOf("--ctx-checkpoints");
      expect(fixture.spawned.args![checkpoints + 1]).toBe("16");
      // sampling knobs are always passed, so a run is reproducible from the profile
      const temp = fixture.spawned.args!.indexOf("--temp");
      expect(fixture.spawned.args![temp + 1]).toBe("0.8");
      const fit = fixture.spawned.args!.indexOf("--fit-target");
      expect(fixture.spawned.args![fit + 1]).toBe("300");
      expect(fixture.spawned.args).not.toContain("--no-kv-offload");
      const reasoningBudget = fixture.spawned.args!.indexOf("--reasoning-budget");
      expect(reasoningBudget).toBeGreaterThanOrEqual(0);
      expect(fixture.spawned.args![reasoningBudget + 1]).toBe("-1");

      const stopped = await manager.stop();
      expect(stopped.state).toBe("stopped");
      expect(fixture.serving()).toBe(false);

      await manager.start({
        port: 18_080,
        contextTokens: 32_768,
        tuning: { temperature: 0.4, dryMultiplier: 0.8, fitTarget: 1024 },
        kvOffload: false,
        cacheV: "turbo4",
        flashAttention: false,
      });
      const args = fixture.spawned.args!;
      expect(args[args.indexOf("--temp") + 1]).toBe("0.4");
      expect(args[args.indexOf("--dry-multiplier") + 1]).toBe("0.8");
      expect(args[args.indexOf("--fit-target") + 1]).toBe("1024");
      // knobs left unset still get Atomic's default rather than being omitted
      expect(args[args.indexOf("--top-k") + 1]).toBe("40");
      expect(args).toContain("--no-kv-offload");
      // without flash attention a quantized cache is refused or crawls
      expect(args[args.indexOf("-fa") + 1]).toBe("off");
      expect(args[args.indexOf("-ctk") + 1]).toBe("f16");
      expect(args[args.indexOf("-ctv") + 1]).toBe("f16");
      expect(args[args.indexOf("-ctkd") + 1]).toBe("f16");
      await manager.stop();
    } finally {
      await rmTempDir(root);
    }
  });

  test("offers mmproj files as projectors, not as models", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    try {
      const model = path.join(root, "story-model.gguf");
      await writeGgufFixture(model, { architecture: "qwen35" });
      const projector = path.join(root, "mmproj-story-model-F16.gguf");
      await writeGgufFixture(projector, { architecture: "clip" });
      const manager = createLocalRuntimeManager({
        rootDir: path.join(root, "local"),
        modelsDir: root,
        platform: "linux",
        arch: "x64",
        hardware: { rocm: false, vulkan: false },
        fetch: fixture.fetch,
        runCommand: fixture.runCommand,
        spawnServer: fixture.spawnServer,
        isPidAlive: fixture.isPidAlive,
        ownsPid: async () => true,
        killPid: fixture.killPid,
        sleep: async () => {},
      });

      await manager.install({ backend: "cpu", model: { source: model } });

      // the projector must not masquerade as a loadable model
      const status = await manager.status();
      const aliases = (status.installation?.models ?? []).map((m) => m.alias);
      expect(aliases).not.toContain("mmproj-story-model");
      expect(aliases.some((a) => a.includes("mmproj"))).toBe(false);

      // but it is offered as a projector
      const candidates = await manager.listMmproj();
      expect(candidates.map((file) => file.name)).toEqual([
        "mmproj-story-model-F16.gguf",
      ]);

      // and once attached it reaches the engine
      const primary = aliases[0]!;
      await manager.setModelMmproj(primary, projector);
      await manager.start({ port: 18_081, contextTokens: 32_768 });
      const args = fixture.spawned.args ?? [];
      expect(args).toContain("--mmproj");
      expect(args[args.indexOf("--mmproj") + 1]).toBe(projector);

      await manager.setModelMmproj(primary, undefined);
      const cleared = await manager.status();
      expect(cleared.installation?.models[0]?.mmproj).toBeUndefined();
    } finally {
      await rmTempDir(root);
    }
  });

  test("stops an Atomic left behind after its run record was lost", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    try {
      const model = path.join(root, "story-model.gguf");
      await writeGgufFixture(model, { architecture: "qwen35" });
      const reapRequests: Array<{ serverPath: string; port: number }> = [];
      const manager = createLocalRuntimeManager({
        rootDir: path.join(root, "local"),
        platform: "linux",
        arch: "x64",
        hardware: { rocm: false, vulkan: false },
        fetch: fixture.fetch,
        runCommand: fixture.runCommand,
        spawnServer: fixture.spawnServer,
        isPidAlive: fixture.isPidAlive,
        ownsPid: async () => true,
        killPid: fixture.killPid,
        findManagedPids: async (serverPath, port) => {
          reapRequests.push({ serverPath, port });
          return fixture.serving() ? [4242] : [];
        },
        sleep: async () => {},
      });

      const installation = await manager.install({
        backend: "cpu",
        model: { source: model },
      });
      await manager.start({ port: 18_080, contextTokens: 32_768 });
      expect(fixture.serving()).toBe(true);

      // a failed start or a host that exited without stopping Atomic leaves the
      // engine holding the GPU with nothing pointing at it
      await rm(path.join(root, "local", "run.json"), { force: true });

      const stopped = await manager.stop();
      expect(stopped.state).toBe("stopped");
      expect(fixture.serving()).toBe(false);
      expect(reapRequests).toEqual([
        { serverPath: installation.runtime.serverPath, port: 18_080 },
      ]);
    } finally {
      await rmTempDir(root);
    }
  });


  test("starts LongCat with its compatible cache and embedded MTP profile", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    try {
      const model = path.join(
        root,
        "LongCat-Flash-Lite-Sparse-Native-MTP-Q4_K_M.gguf",
      );
      await writeGgufFixture(model, {
        architecture: "longcat-flash-sparse",
        values: {
          "longcat-flash-sparse.mtp.num_layers": 3,
          "longcat-flash-sparse.mtp.replicate_modules": true,
          "longcat-flash-sparse.mtp.dsa_cli": true,
        },
      });
      const manager = createLocalRuntimeManager({
        rootDir: path.join(root, "local"),
        platform: "linux",
        arch: "x64",
        hardware: { rocm: false, vulkan: false },
        fetch: fixture.fetch,
        runCommand: fixture.runCommand,
        spawnServer: fixture.spawnServer,
        isPidAlive: fixture.isPidAlive,
        ownsPid: async () => true,
        killPid: fixture.killPid,
        sleep: async () => {},
      });

      await manager.install({ backend: "cpu", model: { source: model } });
      await manager.start({ port: 18_081, contextTokens: 65_536 });

      const args = fixture.spawned.args!;
      const cacheK = args.indexOf("-ctk");
      const cacheV = args.indexOf("-ctv");
      const fitTarget = args.indexOf("--fit-target");
      const draftMax = args.indexOf("--spec-draft-n-max");
      expect(args[cacheK + 1]).toBe("bf16");
      expect(args[cacheV + 1]).toBe("bf16");
      expect(args[fitTarget + 1]).toBe("1024");
      expect(args).toContain("draft-mtp");
      expect(args[draftMax + 1]).toBe("1");
    } finally {
      await rmTempDir(root);
    }
  });

  function managerFor(root: string, fixture: RuntimeFixture) {
    return createLocalRuntimeManager({
      rootDir: path.join(root, "local"),
      platform: "linux",
      arch: "x64",
      hardware: { rocm: false, vulkan: false },
      fetch: fixture.fetch,
      runCommand: fixture.runCommand,
      spawnServer: fixture.spawnServer,
      isPidAlive: fixture.isPidAlive,
      ownsPid: async () => true,
      killPid: fixture.killPid,
      sleep: async () => {},
    });
  }

  test("ignores an MTP filename when the GGUF header has no NextN layers", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    try {
      const model = path.join(root, "story-model-mtp-stripped.gguf");
      await writeGgufFixture(model, {
        architecture: "qwen35",
        values: { "qwen35.block_count": 64 },
      });
      const manager = managerFor(root, fixture);
      await manager.install({ backend: "cpu", model: { source: model } });
      const messages: string[] = [];
      const running = await manager.start({
        port: 18_082,
        onProgress: (progress) => messages.push(progress.message),
      });
      const args = fixture.spawned.args!;
      expect(args).not.toContain("--spec-type");
      expect(args).not.toContain("draft-mtp");
      expect(args).not.toContain("-ctkd");
      expect(running.speculative).toBe("off");
      expect(messages.some((m) => m.startsWith("MTP off:"))).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });

  test("starts a REAP-pruned DeepSeek-V4 with one cache type and no phantom MTP", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    try {
      // REAP compact files keep nextn_predict_layers but ship no NextN block
      const model = path.join(root, "DeepSeek-V4-Flash-REAP-K128.gguf");
      await writeGgufFixture(model, {
        architecture: "deepseek4",
        values: {
          "deepseek4.block_count": 43,
          "deepseek4.nextn_predict_layers": 1,
          "reap.enabled": true,
          "reap.layout": "ds4-compact-v1",
        },
        tensors: ["token_embd.weight", "blk.0.ffn_gate_inp.weight", "blk.42.ffn_gate_inp.weight"],
      });
      const manager = managerFor(root, fixture);
      await manager.install({ backend: "cpu", model: { source: model } });
      const messages: string[] = [];
      const running = await manager.start({
        port: 18_084,
        cacheK: "q8_0",
        cacheV: "turbo4",
        onProgress: (progress) => messages.push(progress.message),
      });
      const args = fixture.spawned.args!;
      expect(args[args.indexOf("-ctk") + 1]).toBe("q8_0");
      expect(args[args.indexOf("-ctv") + 1]).toBe("q8_0");
      expect(messages).toContain("This model keeps K and V in one cache; using q8_0 for both.");
      // its CUDA graph needs more room than the default 300 MiB headroom leaves
      expect(args[args.indexOf("--fit-target") + 1]).toBe("1024");
      // its CUDA graph needs room the default 300 MiB headroom does not leave
      expect(args[args.indexOf("--fit-target") + 1]).toBe("1024");
      expect(args).not.toContain("--spec-type");
      expect(running.speculative).toBe("off");
      expect(messages).toContain(
        "MTP off: deepseek4.nextn_predict_layers = 1 but the file has no blk.42.nextn.eh_proj.weight.",
      );
    } finally {
      await rmTempDir(root);
    }
  });

  test("launches with the model's own sampling unless the player set a knob", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    try {
      const model = path.join(root, "tuned.gguf");
      await writeGgufFixture(model, {
        architecture: "qwen35",
        values: { "general.sampling.temp": 0.6, "general.sampling.top_k": 20 },
      });
      const manager = managerFor(root, fixture);
      await manager.install({ backend: "cpu", model: { source: model } });
      await manager.start({ port: 18_085, tuning: { topK: 50 } });
      const args = fixture.spawned.args!;
      const flag = (name: string) => args[args.indexOf(name) + 1];
      // the model's recommendation, then the player's choice, then Atomic's
      expect(flag("--temp")).toBe("0.6");
      expect(flag("--top-k")).toBe("50");
      expect(flag("--top-p")).toBe("0.95");
    } finally {
      await rmTempDir(root);
    }
  });

  test("enables embedded MTP from the header even with a plain filename", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    try {
      const model = path.join(root, "ornith-q4.gguf");
      await writeGgufFixture(model, {
        architecture: "qwen35moe",
        values: { "qwen35moe.nextn_predict_layers": 1 },
        stringArray: { key: "tokenizer.ggml.tokens", count: 2000 },
      });
      const manager = managerFor(root, fixture);
      await manager.install({ backend: "cpu", model: { source: model } });
      const running = await manager.start({ port: 18_083, cacheK: "q4_0", cacheV: "turbo4" });
      const args = fixture.spawned.args!;
      const specType = args.indexOf("--spec-type");
      expect(args[specType + 1]).toBe("draft-mtp");
      expect(args[args.indexOf("--spec-draft-n-max") + 1]).toBe("2");
      expect(args[args.indexOf("-ctk") + 1]).toBe("q4_0");
      expect(args[args.indexOf("-ctkd") + 1]).toBe("q4_0");
      expect(args[args.indexOf("-ctvd") + 1]).toBe("turbo4");
      expect(running.speculative).toContain("embedded");
    } finally {
      await rmTempDir(root);
    }
  });

  test("refuses to start with a registered draft file that has no NextN layers", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    try {
      const model = path.join(root, "story.gguf");
      await writeGgufFixture(model, { architecture: "qwen35" });
      const draft = path.join(root, "mtp-head.gguf");
      await writeGgufFixture(draft, { architecture: "qwen35" });
      const manager = managerFor(root, fixture);
      await manager.install({
        backend: "cpu",
        model: { source: model },
        mtp: { source: draft },
      });
      await expect(manager.start({ port: 18_084 })).rejects.toThrow(
        /Registered MTP file has no multi-token-prediction layers/,
      );
      expect(fixture.spawned.args).toBeUndefined();
    } finally {
      await rmTempDir(root);
    }
  });

  test("includes current Atomic output when model startup exits", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    const rootDir = path.join(root, "local");
    try {
      const model = path.join(root, "broken.gguf");
      await Bun.write(model, "model fixture");
      const installer = createLocalRuntimeManager({
        rootDir,
        platform: "linux",
        arch: "x64",
        hardware: { rocm: false, vulkan: false },
        fetch: fixture.fetch,
        runCommand: fixture.runCommand,
      });
      await installer.install({ backend: "cpu", model: { source: model } });

      const manager = createLocalRuntimeManager({
        rootDir,
        platform: "linux",
        arch: "x64",
        fetch: fixture.fetch,
        spawnServer: async (_command, _args, logPath) => {
          await Bun.write(
            logPath,
            "ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory\n",
          );
          return 5252;
        },
        isPidAlive: () => false,
        ownsPid: async () => true,
        killPid: () => {},
        sleep: async () => {},
      });

      await expect(manager.start({ port: 18_082 })).rejects.toThrow(
        "cudaMalloc failed: out of memory",
      );
    } finally {
      await rmTempDir(root);
    }
  });

  test("starts the model selected from the installed catalog", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    try {
      const firstModel = path.join(root, "first.gguf");
      const secondModel = path.join(root, "second.gguf");
      await Bun.write(firstModel, "first");
      await Bun.write(secondModel, "second");
      const manager = createLocalRuntimeManager({
        rootDir: path.join(root, "local"),
        platform: "linux",
        arch: "x64",
        hardware: { rocm: false, vulkan: false },
        fetch: fixture.fetch,
        runCommand: fixture.runCommand,
        spawnServer: fixture.spawnServer,
        isPidAlive: fixture.isPidAlive,
        ownsPid: async () => true,
        killPid: fixture.killPid,
        sleep: async () => {},
      });
      await manager.install({
        backend: "cpu",
        model: { source: firstModel },
        alias: "first",
      });
      await manager.install({
        backend: "cpu",
        model: { source: secondModel },
        alias: "second",
      });

      await manager.start({ port: 18_081, model: "second" });

      const modelFlag = fixture.spawned.args!.indexOf("-m");
      expect(fixture.spawned.args![modelFlag + 1]).toBe(secondModel);
      expect(fixture.spawned.args).toContain("second");
    } finally {
      await rmTempDir(root);
    }
  });

  test("discovers GGUF files from the model folder without catalog registration", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    const modelsDir = path.join(root, "models");
    try {
      await mkdir(modelsDir, { recursive: true });
      const registered = path.join(modelsDir, "Registered.gguf");
      await Bun.write(registered, "registered");
      const manager = createLocalRuntimeManager({
        rootDir: path.join(root, "local"),
        modelsDir,
        platform: "linux",
        arch: "x64",
        hardware: { rocm: false, vulkan: false },
        fetch: fixture.fetch,
        runCommand: fixture.runCommand,
        spawnServer: fixture.spawnServer,
        isPidAlive: fixture.isPidAlive,
        ownsPid: async () => true,
        killPid: fixture.killPid,
        sleep: async () => {},
      });
      await manager.install({
        backend: "cpu",
        model: { source: registered },
        alias: "registered",
      });

      const added = path.join(modelsDir, "New-Story-Q4_K_M.gguf");
      await Bun.write(added, "added later");
      await rm(registered);

      const status = await manager.status();
      expect(status.installation?.models.map((model) => model.alias)).toEqual([
        "new-story",
      ]);

      await manager.start({ port: 18_083, model: "new-story" });
      const modelFlag = fixture.spawned.args!.indexOf("-m");
      expect(fixture.spawned.args![modelFlag + 1]).toBe(added);
      expect(fixture.spawned.args).toContain("new-story");
    } finally {
      await rmTempDir(root);
    }
  });

  test("downloads another model without changing or deleting the active model", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture();
    try {
      const manager = createLocalRuntimeManager({
        rootDir: path.join(root, "local"),
        platform: "linux",
        arch: "x64",
        hardware: { rocm: false, vulkan: false },
        fetch: fixture.fetch,
        runCommand: fixture.runCommand,
      });
      const first = await manager.install({
        backend: "cpu",
        model: {
          source: "https://downloads.example/first.gguf",
          sha256: MODEL_SHA,
        },
        alias: "first",
      });
      const firstPath = first.models[0]!.primaryPath;

      const downloaded = await manager.downloadModel({
        source: "https://downloads.example/second.gguf",
        sha256: MODEL_SHA,
      });
      const unchanged = await manager.status({ port: 19_999 });

      expect(downloaded.files).toHaveLength(1);
      expect(await Bun.file(downloaded.files[0]!.path).exists()).toBe(true);
      expect(unchanged.installation?.models[0]?.alias).toBe("first");
      expect(unchanged.installation?.models[0]?.primaryPath).toBe(firstPath);

      const catalog = await manager.install({
        backend: "cpu",
        model: {
          source: "https://downloads.example/second.gguf",
          sha256: MODEL_SHA,
        },
        alias: "second",
      });
      expect(catalog.models.map((model) => model.alias)).toEqual([
        "first",
        "second",
      ]);
      expect(catalog.defaultModel).toBe("first");
      expect(await Bun.file(firstPath).exists()).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });

  test("rejects a runtime archive whose digest does not match", async () => {
    const root = await makeTempDir();
    const fixture = createRuntimeFixture("0".repeat(64));
    try {
      const manager = createLocalRuntimeManager({
        rootDir: path.join(root, "local"),
        platform: "linux",
        arch: "x64",
        hardware: { rocm: false, vulkan: false },
        fetch: fixture.fetch,
        runCommand: fixture.runCommand,
      });

      await expect(manager.install({ backend: "cpu" })).rejects.toThrow("SHA-256 mismatch");
      expect(await pathExists(root, "local/installation.json")).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("migrates a single-model installation into the catalog", async () => {
    const root = await makeTempDir();
    const localRoot = path.join(root, "local");
    try {
      await mkdir(localRoot, { recursive: true });
      const modelPath = path.join(root, "legacy.gguf");
      await Bun.write(modelPath, "legacy");
      await Bun.write(
        path.join(localRoot, "installation.json"),
        JSON.stringify({
          schema: 1,
          runtime: {
            release: "legacy",
            target: {
              platform: "linux",
              arch: "x64",
              backend: "cpu",
              assetName: "atomic-legacy",
            },
            root: path.join(localRoot, "runtime"),
            serverPath: path.join(localRoot, "runtime", "llama-server"),
          },
          model: {
            alias: "legacy-model",
            source: modelPath,
            files: [{
              name: "legacy.gguf",
              path: modelPath,
              external: true,
            }],
            primaryPath: modelPath,
          },
        }),
      );
      const manager = createLocalRuntimeManager({
        rootDir: localRoot,
        fetch: async () => {
          throw new TypeError("offline");
        },
      });

      const status = await manager.status({ port: 19_999 });
      const persisted = JSON.parse(
        await Bun.file(path.join(localRoot, "installation.json")).text(),
      ) as Record<string, unknown>;

      expect(status.installation?.schema).toBe(2);
      expect(status.installation?.defaultModel).toBe("legacy-model");
      expect(status.installation?.models.map((model) => model.alias)).toEqual([
        "legacy-model",
      ]);
      expect(persisted.schema).toBe(2);
      expect("model" in persisted).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });


  test("reports an uninstalled runtime on an unused endpoint", async () => {
    const root = await makeTempDir();
    try {
      const offlineFetch: LocalFetch = async () => {
        throw new TypeError("offline");
      };
      const manager = createLocalRuntimeManager({
        rootDir: path.join(root, "local"),
        fetch: offlineFetch,
      });

      const status = await manager.status({ port: 19_999 });

      expect(status).toMatchObject({
        state: "not-installed",
        endpoint: "http://127.0.0.1:19999",
        installed: false,
        managed: false,
      });
    } finally {
      await rmTempDir(root);
    }
  });

  test("never stops an external llama.cpp server", async () => {
    const root = await makeTempDir();
    let killed = false;
    try {
      const externalFetch: LocalFetch = async () =>
        Response.json({ data: [{ id: "external-model" }] });
      const manager = createLocalRuntimeManager({
        rootDir: path.join(root, "local"),
        fetch: externalFetch,
        killPid() {
          killed = true;
        },
      });

      const status = await manager.stop();

      expect(status.state).toBe("external");
      expect(status.models).toEqual(["external-model"]);
      expect(killed).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });
  test("a Vulkan engine downloads beside the running CUDA one, and the chosen card is found by name", async () => {
    const root = await makeTempDir();
    try {
      const nvidia = "NVIDIA GeForce RTX 3080 Ti";
      const arc = "Intel(R) Arc(TM) Pro B70 Graphics";
      // Atomic's releases, as real archives of engines that list their cards
      const releases = new Map<string, Uint8Array>();
      for (const [backend, devices] of [
        ["cuda-12.4", `Available devices:\n  CUDA0: ${nvidia} (12136 MiB, 11421 MiB free)\n`],
        [
          "vulkan",
          "Available devices:\n" +
            `  Vulkan0: ${nvidia} (12288 MiB, 11000 MiB free)\n` +
            `  Vulkan1: ${arc} (32656 MiB, 32000 MiB free)\n`,
        ],
      ] as const) {
        const staging = path.join(root, "release", backend);
        await writeDeviceScript(path.join(staging, "build", "bin", "llama-server"), devices);
        const archive = path.join(root, "release", `${backend}.tar.gz`);
        await Bun.$`tar -czf ${archive} -C ${staging} build`.quiet();
        releases.set(
          `llama-turboquant-linux-x64-${backend}.tar.gz`,
          new Uint8Array(await Bun.file(archive).arrayBuffer()),
        );
      }
      const model = path.join(root, "story-model.gguf");
      await writeGgufFixture(model, { architecture: "qwen3" });

      let serving = false;
      let kills = 0;
      const spawned: Array<{ command: string; args: string[] }> = [];
      const manager = createLocalRuntimeManager({
        rootDir: path.join(root, "local"),
        modelsDir: root,
        platform: "linux",
        arch: "x64",
        hardware: {
          nvidia: { driverMajor: 570, computeCapability: 8.6 },
          rocm: false,
          vulkan: false,
        },
        fetch: async (input) => {
          const url = String(input);
          if (url.includes("api.github.com/repos/AtomicBot-ai/")) {
            return Response.json({
              assets: [...releases].map(([name, bytes]) => ({
                name,
                browser_download_url: `https://downloads.example/${name}`,
                digest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
                size: bytes.byteLength,
              })),
            });
          }
          const asset = releases.get(url.slice("https://downloads.example/".length));
          if (asset) return new Response(asset as Uint8Array<ArrayBuffer>);
          if (url.endsWith("/v1/models")) {
            if (!serving) throw new TypeError("Server is not listening.");
            return Response.json({ data: [{ id: "story-model" }] });
          }
          throw new Error(`Unexpected fetch: ${url}`);
        },
        spawnServer: async (command, args) => {
          spawned.push({ command, args: [...args] });
          serving = true;
          return 4242;
        },
        isPidAlive: (pid) => pid === 4242 && serving,
        ownsPid: async () => true,
        findManagedPids: async () => (serving ? [4242] : []),
        killPid: () => {
          kills += 1;
          serving = false;
        },
        sleep: async () => {},
      });
      const device = (index: number) => {
        const args = spawned[index]!.args;
        return args.includes("--device") ? args[args.indexOf("--device") + 1] : undefined;
      };

      const installation = await manager.install({ model: { source: model } });
      expect(installation.runtime.target.backend).toBe("cuda-12.4");
      // a build an earlier install left behind is not offered as another card
      await writeDeviceScript(
        path.join(root, "local", "runtime", installation.runtime.release, "cuda-13.3", "build", "bin", "llama-server"),
        `Available devices:\n  CUDA0: ${nvidia} (12136 MiB, 11421 MiB free)\n`,
      );
      expect(await manager.listGpus()).toEqual({
        gpus: [{ backend: "cuda-12.4", device: "CUDA0", name: nvidia, memoryMiB: 12_136 }],
        primaryBackend: "cuda-12.4",
        downloadable: ["vulkan"],
      });

      // with no card chosen, the installed build runs as it always has
      await manager.start({ port: 18_080 });
      expect(spawned[0]!.command).toBe(installation.runtime.serverPath);
      expect(device(0)).toBeUndefined();

      // the download lands beside the CUDA build without stopping the engine
      await manager.installEngine("vulkan");
      expect(serving).toBe(true);
      expect(kills).toBe(0);
      const listed = await manager.listGpus();
      expect(listed.downloadable).toEqual([]);
      expect(listed.gpus.map((gpu) => `${gpu.backend} ${gpu.device} ${gpu.name}`)).toEqual([
        `cuda-12.4 CUDA0 ${nvidia}`,
        `vulkan Vulkan0 ${nvidia}`,
        `vulkan Vulkan1 ${arc}`,
      ]);
      const vulkanServer = path.join(
        root, "local", "runtime", installation.runtime.release, "vulkan", "build", "bin", "llama-server",
      );

      const gpu = { backend: "vulkan", device: "Vulkan1", name: arc } as const;
      await manager.stop();
      await manager.start({ port: 18_080, gpu });
      expect(spawned[1]!.command).toBe(vulkanServer);
      expect(device(1)).toBe("Vulkan1");
      expect((await manager.status()).state).toBe("running");

      // a driver added later renumbers the cards; the Arc is found by name
      await Bun.write(
        path.join(path.dirname(vulkanServer), "devices.txt"),
        "Available devices:\n" +
          `  Vulkan0: ${arc} (32656 MiB, 32000 MiB free)\n` +
          `  Vulkan1: ${nvidia} (12288 MiB, 11000 MiB free)\n`,
      );
      await manager.stop();
      await manager.start({ port: 18_080, gpu });
      expect(device(2)).toBe("Vulkan0");

      // and a card that is gone is refused rather than silently swapped
      await Bun.write(
        path.join(path.dirname(vulkanServer), "devices.txt"),
        `Available devices:\n  Vulkan0: ${nvidia} (12288 MiB, 11000 MiB free)\n`,
      );
      await manager.stop();
      await expect(manager.start({ port: 18_080, gpu })).rejects.toThrow(
        `${arc} is not available to the vulkan engine.`,
      );
      expect(spawned).toHaveLength(3);
    } finally {
      await rmTempDir(root);
    }
  });
});
