import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  LocalInferenceController,
  type LocalIllustrationCandidate,
} from "@nq/local-inference/inference.ts";
import { illustrationCandidateAbs } from "../../src/play/illustration.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { writeGgufFixture } from "../helpers/gguf.ts";
import { markExl3xpuInstalled, writeExl3Fixture } from "../helpers/local_host.ts";
import {
  fakeLocalRuntime,
  reservePort,
  type FakeLocalRuntime,
} from "../helpers/local_runtime.ts";

/** Where the Play Loop puts a Turn's candidate pictures in its Campaign. */
function candidatePaths(campaign: string, count: number): string[] {
  return Array.from({ length: count }, (_, slot) =>
    illustrationCandidateAbs(campaign, "2026-08-29T10:00:00.000Z", slot),
  );
}

/**
 * The real LocalInferenceController over the real runtime manager, a real
 * installation on disk, and the real Anima tool lookup and sd-cli spawning.
 * Only the external processes are fakes: the Atomic engine (a local HTTP
 * server started in place of llama-server) and sd-cli (a shell script that
 * writes the PNG it is asked for).
 */

type Rig = {
  root: string;
  engine: FakeLocalRuntime;
  animaDir: string;
  inference: LocalInferenceController;
  /** Seeds sd-cli was run with, oldest first. */
  painted(): Promise<number[]>;
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SD_CLI = `#!/bin/sh
dir="$(dirname "$0")"
out=""; seed=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -s) seed="$2"; shift ;;
  esac
  shift
done
echo "$seed" >> "$dir/painted.log"
if [ -f "$dir/hold" ]; then
  touch "$dir/started"
  exec sleep 30
fi
printf png > "$out"
`;

async function rig(): Promise<Rig> {
  const root = await makeTempDir();
  const enginePort = reservePort();
  const engine = await fakeLocalRuntime({
    rootDir: path.join(root, "local"),
    enginePort,
  });
  const animaDir = path.join(root, "anima");
  await mkdir(animaDir, { recursive: true });
  await Bun.write(path.join(animaDir, "sd-cli"), SD_CLI);
  await chmod(path.join(animaDir, "sd-cli"), 0o755);
  await Bun.write(path.join(animaDir, "anima-preview.gguf"), "diffusion");
  await Bun.write(path.join(animaDir, "qwen_3_06b.safetensors"), "llm");
  await Bun.write(path.join(animaDir, "qwen_image_vae.safetensors"), "vae");
  const inference = await LocalInferenceController.open({
    runtime: engine.runtime,
    enginePort,
    animaDir,
  });
  cleanups.push(async () => {
    await inference.close().catch(() => {});
    engine.shutdown();
    await rmTempDir(root);
  });
  return {
    root,
    engine,
    animaDir,
    inference,
    painted: async () =>
      (await readFile(path.join(animaDir, "painted.log"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map(Number),
  };
}

/**
 * Whether the controller admits a text request right now. An admitted request
 * resolves synchronously; a queued one does not, so a race against an already
 * settled promise tells them apart without waiting. Admitted probes are
 * released at once.
 */
async function admitsText(inference: LocalInferenceController): Promise<boolean> {
  const pending = inference.acquireTextRequest();
  const release = await Promise.race([pending, Promise.resolve(undefined)]);
  if (release) {
    release();
    return true;
  }
  void pending.then((late) => late()).catch(() => {});
  return false;
}

async function until(ok: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await Bun.sleep(1);
  }
}

describe("LocalInferenceController", () => {
  test("activates Atomic only when the local Game Master is requested", async () => {
    const { engine, inference, root } = await rig();
    const port = inference.enginePort;

    expect(inference.status().phase).toBe("idle");
    expect(engine.events).toEqual([]);

    await inference.activate({
      model: "local-test",
      contextTokens: 32_768,
      reasoningTokens: 2_048,
    });
    expect(engine.events).toEqual([`start:${port}:local-test:32768:2048`]);
    expect(engine.running()).toBe(true);

    expect(inference.status("http://127.0.0.1:8080")).toEqual({
      phase: "game-master",
      activeProfile: {
        model: "local-test",
        contextTokens: 32_768,
        reasoningTokens: 2_048,
        cacheK: "q8_0",
        cacheV: "turbo3",
        tuning: {},
        kvOffload: true,
        flashAttention: true,
        parallel: 1,
        ramCacheGiB: 0,
      },
      gameMasterEndpoint: "http://127.0.0.1:8080",
    });
    // same profile: nothing to do
    await inference.activate({
      model: "local-test",
      contextTokens: 32_768,
      reasoningTokens: 2_048,
    });
    expect(engine.events).toEqual([`start:${port}:local-test:32768:2048`]);

    // swapping only the projector still has to restart the server
    const projector = path.join(root, "mmproj-vision.gguf");
    await writeGgufFixture(projector, { architecture: "clip" });
    await engine.runtime.setModelMmproj("local-test", projector);
    await inference.activate({
      model: "local-test",
      contextTokens: 32_768,
      reasoningTokens: 2_048,
    });
    expect(engine.events).toEqual([
      `start:${port}:local-test:32768:2048`,
      "stop",
      `start:${port}:local-test:32768:2048`,
    ]);
    expect(engine.spawns.at(-1)).toContain(projector);
    expect(inference.status().activeProfile?.mmproj).toBe(projector);

    await inference.close();
    expect(engine.running()).toBe(false);
  });

  test("waits for text, paints one batch, then restores the exact profile", async () => {
    const { engine, inference, root, painted } = await rig();
    const port = inference.enginePort;
    const candidates: LocalIllustrationCandidate[] = [];
    await inference.activate({
      model: "local-test",
      contextTokens: 40_000,
      reasoningTokens: 1_500,
    });
    engine.events.length = 0;

    const releaseText = await inference.acquireTextRequest();
    const painting = inference.illustrate({
      prompt: "pov, forest",
      seeds: [11, 22, 33, 44],
      outPaths: candidatePaths(root, 4),
      onCandidate: (candidate) => candidates.push(candidate),
    });
    // the painter has closed the door to new text and waits on the open request
    await until(async () => !(await admitsText(inference)));
    const queuedText = inference.acquireTextRequest();
    let queuedResolved = false;
    void queuedText.then(() => {
      queuedResolved = true;
    });
    expect(engine.events).toEqual([]);
    expect(await painted()).toEqual([]);
    expect(engine.running()).toBe(true);
    expect(queuedResolved).toBe(false);

    releaseText();
    await painting;
    const releaseQueued = await queuedText;
    releaseQueued();

    expect(await painted()).toEqual([11, 22, 33, 44]);
    expect(candidates.map((candidate) => candidate.slot)).toEqual([0, 1, 2, 3]);
    for (const candidate of candidates) {
      expect(await Bun.file(candidate.path).text()).toBe("png");
    }
    expect(engine.events).toEqual(["stop", `start:${port}:local-test:40000:1500`]);
    expect(inference.status().phase).toBe("game-master");
    expect(engine.running()).toBe(true);
  });

  test("cancellation still restores Atomic before rejecting", async () => {
    const { engine, inference, root, animaDir } = await rig();
    const port = inference.enginePort;
    await Bun.write(path.join(animaDir, "hold"), "");
    await inference.activate({
      model: "local-test",
      contextTokens: 24_000,
      reasoningTokens: 900,
    });
    engine.events.length = 0;

    const abort = new AbortController();
    const painting = inference.illustrate({
      prompt: "pov, river",
      seeds: [1, 2, 3, 4],
      outPaths: candidatePaths(root, 4),
      signal: abort.signal,
    });
    await until(() => Bun.file(path.join(animaDir, "started")).exists());
    expect(engine.running()).toBe(false);
    abort.abort();

    await painting.then(
      () => {
        throw new Error("expected cancellation");
      },
      (error) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("interrupted");
      },
    );
    expect(engine.events).toEqual(["stop", `start:${port}:local-test:24000:900`]);
    expect(inference.status().phase).toBe("game-master");
    expect(engine.running()).toBe(true);
  });

  test("an exl3xpu Game Master keeps its engine and its text while an Illustration paints", async () => {
    const { engine, inference, root, painted } = await rig();
    // an EXL3 model runs on the Intel GPU; NQ's sd-cli builds are CUDA, so no swap
    await writeExl3Fixture(path.join(engine.rootDir, "models", "Twilight-EXL3"));
    await markExl3xpuInstalled(engine.rootDir);
    await inference.activate({ model: "twilight-exl3", contextTokens: 24_000, reasoningTokens: 900 });
    expect(engine.events).toHaveLength(1);
    expect(engine.spawns[0]).toContain("/opt/venv/bin/vllm");

    // a turn is still streaming when the painter starts
    const releaseText = await inference.acquireTextRequest();
    await inference.illustrate({
      prompt: "pov, lighthouse",
      seeds: [5, 6],
      outPaths: candidatePaths(root, 2),
    });
    expect(await painted()).toEqual([5, 6]);
    expect(await admitsText(inference)).toBe(true);
    releaseText();
    // never stopped, never restarted
    expect(engine.events).toHaveLength(1);
    expect(engine.running()).toBe(true);
    expect(inference.status().phase).toBe("game-master");
  });

  test("a remote Game Master paints without starting or restoring Atomic", async () => {
    const { engine, inference, root, painted } = await rig();
    await inference.illustrate({
      prompt: "pov, tavern",
      seeds: [1, 2, 3, 4],
      outPaths: candidatePaths(root, 4),
    });
    expect(await painted()).toEqual([1, 2, 3, 4]);
    expect(engine.events).toEqual([]);
    expect(inference.status().phase).toBe("idle");
  });

  test("a missing sd-cli fails the Illustration without touching Atomic", async () => {
    const { engine, inference, root, animaDir } = await rig();
    await inference.activate({ model: "local-test" });
    engine.events.length = 0;
    await Bun.$`rm ${path.join(animaDir, "sd-cli")}`.quiet();
    await expect(
      inference.illustrate({
        prompt: "pov, tavern",
        seeds: [1],
        outPaths: candidatePaths(root, 1),
      }),
    ).rejects.toThrow(animaDir);
    expect(engine.events).toEqual([]);
    expect(inference.status().phase).toBe("game-master");
  });
});
