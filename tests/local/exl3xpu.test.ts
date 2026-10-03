/**
 * The exl3xpu engine through NQ's real runtime manager: pulling the pinned
 * image from its registry and unpacking it with real `tar`, finding EXL3
 * models beside GGUF ones, and launching vLLM in bubblewrap. Faked: the
 * container registry (remote network) and the engine process (spawn).
 */
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLocalRuntimeManager } from "@nq/local-inference/index.ts";
import { makeTempDir, pathExists, rmTempDir } from "../helpers/fs.ts";
import { writeGgufFixture } from "../helpers/gguf.ts";
import { fakeExl3xpuRegistry } from "../helpers/exl3_registry.ts";
import {
  EXL3XPU_IMAGE,
  EXL3XPU_VLLM_FORK,
} from "@nq/local-inference/engines/exl3xpu_image.ts";
import { markExl3xpuInstalled, writeExl3Fixture } from "../helpers/local_host.ts";

describe("the exl3xpu engine", () => {
  test("pulls the pinned image, applies its whiteouts, and patches the plugin for Gemma 4", async () => {
    const root = await makeTempDir();
    try {
      const registry = await fakeExl3xpuRegistry(root);
      const rootDir = path.join(root, "local");
      const manager = createLocalRuntimeManager({ rootDir, fetch: registry.fetch });
      const progress: string[] = [];

      expect(await manager.exl3xpuInstalled()).toBe(false);
      await manager.installExl3xpu({ onProgress: (p) => progress.push(p.message) });
      expect(await manager.exl3xpuInstalled()).toBe(true);

      const rootfs = path.join(rootDir, "engines", "exl3xpu", "rootfs");
      // a whiteout deletes what a lower layer left; an opaque one empties its folder
      expect(await pathExists(rootfs, "opt/stale")).toBe(false);
      expect(await readdir(path.join(rootfs, "etc", "cache"))).toEqual(["b.txt"]);
      expect(await pathExists(rootfs, "opt/venv/bin/vllm")).toBe(true);
      const plugin = await readFile(path.join(rootfs, "opt/exl3xpu/exl3xpu/vllm_plugin.py"), "utf8");
      expect(plugin).toContain('bits[2] = bits[1]');
      expect(plugin).toContain('os.environ.get("EXL3_TIED_LM_HEAD") == "1"');
      // NQ's vLLM fork replaces upstream's copies, fetched at its pinned commit
      for (const file of EXL3XPU_VLLM_FORK.files) {
        expect(await readFile(path.join(rootfs, registry.vllm.site, file.path), "utf8")).toBe(
          registry.vllm.forkText.get(file.path)!,
        );
      }
      expect(registry.requests.filter((url) => url.startsWith("https://raw.githubusercontent.com/"))).toEqual(
        [...registry.vllm.forkFiles.keys()],
      );
      expect(progress).toContain("Unpacking the exl3xpu engine: layer 2 of 2.");
      // nothing of the download is left behind
      expect((await readdir(path.join(rootDir, "engines", "exl3xpu"))).sort()).toEqual([
        "engine.json",
        "rootfs",
      ]);

      // installed engines are not pulled again
      const pulls = registry.requests.length;
      await manager.installExl3xpu();
      expect(registry.requests.length).toBe(pulls);
    } finally {
      await rmTempDir(root);
    }
  });

  test("an engine installed before NQ's vLLM fork is updated in place, without pulling the image again", async () => {
    const root = await makeTempDir();
    try {
      const registry = await fakeExl3xpuRegistry(root);
      const rootDir = path.join(root, "local");
      const manager = createLocalRuntimeManager({ rootDir, fetch: registry.fetch });
      await manager.installExl3xpu();
      // as the previous patch level left it: upstream's vLLM files, older marker
      const engine = path.join(rootDir, "engines", "exl3xpu");
      const rootfs = path.join(engine, "rootfs");
      for (const [file, text] of Object.entries(registry.vllm.imageFiles)) {
        await writeFile(path.join(rootfs, file), text);
      }
      await writeFile(
        path.join(engine, "engine.json"),
        JSON.stringify({ digest: EXL3XPU_IMAGE.digest, patchLevel: 1 }),
      );
      expect(await manager.exl3xpuInstalled()).toBe(false);

      const before = registry.requests.length;
      const progress: string[] = [];
      await manager.installExl3xpu({ onProgress: (p) => progress.push(p.message) });

      expect(await manager.exl3xpuInstalled()).toBe(true);
      const fetched = registry.requests.slice(before);
      expect(fetched.every((url) => url.startsWith("https://raw.githubusercontent.com/"))).toBe(true);
      expect(fetched).toHaveLength(EXL3XPU_VLLM_FORK.files.length);
      expect(progress).toContain("Updating the exl3xpu engine.");
      for (const file of EXL3XPU_VLLM_FORK.files) {
        expect(await readFile(path.join(rootfs, registry.vllm.site, file.path), "utf8")).toBe(
          registry.vllm.forkText.get(file.path)!,
        );
      }
      expect((await readdir(engine)).sort()).toEqual(["engine.json", "rootfs"]);

      // an engine on an earlier fork version is moved to the current one
      expect(registry.vllm.previousText.size).toBeGreaterThan(0);
      for (const [file, text] of registry.vllm.previousText) {
        await writeFile(path.join(rootfs, registry.vllm.site, file), text);
      }
      await writeFile(
        path.join(engine, "engine.json"),
        JSON.stringify({ digest: EXL3XPU_IMAGE.digest, patchLevel: 2 }),
      );
      const again = registry.requests.length;
      await manager.installExl3xpu();
      expect(await manager.exl3xpuInstalled()).toBe(true);
      expect(registry.requests.slice(again)).toHaveLength(registry.vllm.previousText.size);
      for (const file of EXL3XPU_VLLM_FORK.files) {
        expect(await readFile(path.join(rootfs, registry.vllm.site, file.path), "utf8")).toBe(
          registry.vllm.forkText.get(file.path)!,
        );
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("an image whose vLLM is not the fork's base is refused rather than half replaced", async () => {
    const root = await makeTempDir();
    try {
      const altered = EXL3XPU_VLLM_FORK.files[1]!.path;
      const registry = await fakeExl3xpuRegistry(root, { alteredVllmFile: altered });
      const rootDir = path.join(root, "local");
      const manager = createLocalRuntimeManager({ rootDir, fetch: registry.fetch });

      await expect(manager.installExl3xpu()).rejects.toThrow(
        `The exl3xpu image's ${altered} is not the copy built from vLLM ${EXL3XPU_VLLM_FORK.base.slice(0, 9)}`,
      );
      expect(await manager.exl3xpuInstalled()).toBe(false);
      // nothing was fetched from the fork, and nothing half-installed is left
      expect(registry.requests.some((url) => url.includes("raw.githubusercontent.com"))).toBe(false);
      expect(await pathExists(rootDir, "engines/exl3xpu/rootfs")).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("an EXL3 folder is listed beside GGUF models and launches vLLM sandboxed, drafting with its assistant", async () => {
    const root = await makeTempDir();
    try {
      const rootDir = path.join(root, "local");
      const modelsDir = path.join(root, "models");
      await mkdir(modelsDir, { recursive: true });
      await writeGgufFixture(path.join(modelsDir, "story-model-Q4_K_M.gguf"), {
        architecture: "qwen3",
      });
      await writeExl3Fixture(path.join(modelsDir, "Twilight-Embrace-31B-exl3-4.0bpw"), {
        drafter: path.join(modelsDir, "gemma-4-31B-it-assistant"),
      });
      // original weights, not EXL3: never offered as a model
      await mkdir(path.join(modelsDir, "Twilight-Embrace-31B-hf"), { recursive: true });
      await writeFile(
        path.join(modelsDir, "Twilight-Embrace-31B-hf", "config.json"),
        JSON.stringify({ model_type: "gemma4" }),
      );
      await markExl3xpuInstalled(rootDir);
      await mkdir(rootDir, { recursive: true });
      await writeFile(
        path.join(rootDir, "installation.json"),
        JSON.stringify({
          schema: 2,
          runtime: {
            release: "test",
            target: { platform: "linux", arch: "x64", backend: "cpu", assetName: "x.tar.gz" },
            root: path.join(rootDir, "runtime"),
            serverPath: path.join(rootDir, "runtime", "llama-server"),
          },
          models: [],
        }),
      );

      let serving: ReturnType<typeof Bun.serve> | undefined;
      const spawned: Array<{ command: string; args: string[] }> = [];
      const manager = createLocalRuntimeManager({
        rootDir,
        modelsDir,
        spawnServer: async (command, args) => {
          spawned.push({ command, args });
          const port = Number(args[args.indexOf("--port") + 1]);
          serving = Bun.serve({
            hostname: "127.0.0.1",
            port,
            fetch: () => Response.json({ data: [{ id: "twilight-embrace-31b-exl3-4.0bpw" }] }),
          });
          return 4343;
        },
        isPidAlive: (pid) => pid === 4343 && serving !== undefined,
        ownsPid: async () => true,
        findManagedPids: async () => (serving ? [4343] : []),
        killPid: () => {
          serving?.stop(true);
          serving = undefined;
        },
        sleep: async () => {},
      });

      const installation = await manager.installation();
      const exl3 = installation!.models.find((model) => model.format === "exl3");
      expect(installation!.models.map((model) => model.alias).sort()).toEqual([
        "story-model",
        "twilight-embrace-31b-exl3-4.0bpw",
      ]);
      expect(exl3).toMatchObject({
        primaryPath: path.join(modelsDir, "Twilight-Embrace-31B-exl3-4.0bpw"),
        drafter: { name: "gemma-4-31B-it-assistant" },
      });

      const port = 18_000 + Math.floor(Math.random() * 1000);
      const running = await manager.start({
        model: exl3!.alias,
        port,
        contextTokens: 49_152,
        cacheK: "q8_0",
        cacheV: "turbo4",
        tuning: { temperature: 0.7, minP: 0.05, dryMultiplier: 0.8 },
        parallel: 4,
        ramCacheGiB: 16,
      });
      expect(running.state).toBe("running");
      expect(running.speculative).toBe("drafter gemma-4-31B-it-assistant");

      const { command, args } = spawned[0]!;
      const flag = (name: string) => args[args.indexOf(name) + 1];
      expect(path.basename(command)).toBe("bwrap");
      // the engine's root is the unpacked image; models, template and cache are bound in
      expect(args.slice(0, 3)).toEqual([
        "--bind",
        path.join(rootDir, "engines", "exl3xpu", "rootfs"),
        "/",
      ]);
      expect(args).toContain("--unshare-pid");
      expect(args[args.indexOf("/nq/model") - 1]).toBe(exl3!.primaryPath);
      expect(args[args.indexOf("/nq/drafter") - 1]).toBe(
        path.join(modelsDir, "gemma-4-31B-it-assistant"),
      );
      expect(flag("--max-model-len")).toBe("49152");
      // any quantized cache choice is vLLM's fp8
      expect(flag("--kv-cache-dtype")).toBe("fp8");
      expect(flag("--attention-backend")).toBe("FLASH_ATTN");
      // min_p is refused with speculative decoding; DRY has no vLLM equivalent
      expect(JSON.parse(flag("--override-generation-config")!)).toEqual({
        temperature: 0.7,
        top_k: 64,
        top_p: 0.95,
        repetition_penalty: 1,
        presence_penalty: 0,
        frequency_penalty: 0,
      });
      const env = new Map<string, string>();
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--setenv") env.set(args[i + 1]!, args[i + 2]!);
      }
      expect(env.get("EXL3_TIED_LM_HEAD")).toBe("1");
      expect(env.get("ZE_AFFINITY_MASK")).toBe("0");
      // host copies are staged, so the copy engine never reads swapped-out pages in place
      expect(env.get("TreatNonUsmForTransfersAsSharedSystem")).toBe("0");
      expect(env.get("EnableSharedSystemUsmSupport")).toBe("0");
      expect(env.get("NEOReadDebugKeys")).toBe("1");
      // shared games: four at once, and a lazy RAM tier that only takes blocks
      // leaving the card, with sliding-window layers caching only reusable tails
      expect(flag("--max-num-seqs")).toBe("4");
      // decode steps replay captured graphs, one per game count, each verifying 2 drafts + 1
      expect(env.get("VLLM_XPU_ENABLE_XPU_GRAPH")).toBe("1");
      expect(JSON.parse(flag("--compilation-config")!)).toEqual({
        cudagraph_mode: "FULL_DECODE_ONLY",
        cudagraph_capture_sizes: [3, 6, 9, 12],
      });
      expect(JSON.parse(flag("--speculative-config")!)).toMatchObject({
        method: "gemma4_mtp",
        num_speculative_tokens: 2,
      });
      // the drafter proposes from a pruned vocabulary shipped beside the engine module
      expect(env.get("VLLM_GEMMA4_MTP_DRAFT_VOCAB")).toBe("/nq/draft_vocab.json");
      const vocabFile = args[args.indexOf("/nq/draft_vocab.json") - 1]!;
      const vocab = JSON.parse(await readFile(vocabFile, "utf8")) as number[];
      expect(vocab.length).toBeGreaterThan(10_000);
      expect(vocab.length).toBeLessThan(262_144 / 10);
      expect(JSON.parse(flag("--kv-transfer-config")!)).toEqual({
        kv_connector: "SimpleCPUOffloadConnector",
        kv_role: "kv_both",
        kv_connector_extra_config: { cpu_bytes_to_use: 16 * 2 ** 30, lazy_offload: true },
      });
      expect(args).not.toContain("--kv-offloading-size");
      expect(env.get("VLLM_PREFIX_CACHE_RETENTION_INTERVAL")).toBe("0");
      expect(env.get("VLLM_PREFIX_CACHE_REPLAY_SLACK_TOKENS")).toBe("256");
      // nothing from the user's shell reaches vLLM, which logs no prompt or reply
      // text, reports no usage, and cannot dump core
      expect(args.indexOf("--clearenv")).toBeLessThan(args.indexOf("--setenv"));
      expect(env.get("VLLM_DEBUG_LOG_API_SERVER_RESPONSE")).toBe("false");
      expect(env.get("VLLM_SERVER_DEV_MODE")).toBe("0");
      expect(env.get("VLLM_LOGGING_LEVEL")).toBe("INFO");
      expect(env.get("VLLM_NO_USAGE_STATS")).toBe("1");
      expect(args.slice(args.indexOf("/bin/sh"), args.indexOf("/opt/venv/bin/vllm"))).toEqual([
        "/bin/sh",
        "-c",
        'ulimit -c 0 && exec "$@"',
        "sh",
      ]);

      // the model's template with NQ's prefill hook appended
      const template = args[args.indexOf("/nq/chat_template.jinja") - 1]!;
      const text = await readFile(template, "utf8");
      expect(text).toStartWith("{%- set enable_thinking");
      expect(text).toContain("nq_prefill is defined");

      await manager.stop();
      expect(serving).toBeUndefined();
    } finally {
      await rmTempDir(root);
    }
  });

  test("an engine that goes silent while starting is stopped and reported, not waited on for 15 minutes", async () => {
    const root = await makeTempDir();
    try {
      const rootDir = path.join(root, "local");
      const modelsDir = path.join(root, "models");
      await writeExl3Fixture(path.join(modelsDir, "Twilight-EXL3"));
      await markExl3xpuInstalled(rootDir);
      await writeFile(
        path.join(rootDir, "installation.json"),
        JSON.stringify({
          schema: 2,
          runtime: {
            release: "test",
            target: { platform: "linux", arch: "x64", backend: "cpu", assetName: "x.tar.gz" },
            root: path.join(rootDir, "runtime"),
            serverPath: path.join(rootDir, "runtime", "llama-server"),
          },
          models: [],
        }),
      );
      let alive = false;
      const killed: number[] = [];
      const manager = createLocalRuntimeManager({
        rootDir,
        modelsDir,
        // vLLM gets as far as the weights, then its GPU copy never returns
        spawnServer: async (_command, _args, logPath) => {
          await writeFile(logPath, "Loading safetensors checkpoint shards:   0% Completed | 0/3\n", { flag: "a" });
          alive = true;
          return 4545;
        },
        isPidAlive: (pid) => pid === 4545 && alive,
        ownsPid: async () => true,
        findManagedPids: async () => (alive ? [4545] : []),
        killPid: (pid) => {
          killed.push(pid);
          alive = false;
        },
        sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
        startupStallMs: 300,
      });

      const started = manager.start({ model: "twilight-exl3", port: 19_000 + Math.floor(Math.random() * 500) });
      await expect(started).rejects.toThrow(/stopped making progress/);
      await started.catch((error: Error) => {
        // the player sees where it stopped
        expect(error.message).toContain("0/3");
      });
      expect(killed).toContain(4545);
      expect((await manager.status()).managed).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });
});
