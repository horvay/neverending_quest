import type { TestRendererSetup } from "@opentui/core/testing";
import { afterEach } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mergeConfig, type NqConfig } from "../../src/config.ts";
import { HomeSurface, type HomeSurfaceOptions } from "../../src/home/index.ts";
import type { AgentSessionFactory } from "../../src/play/types.ts";
import { runPlay } from "../../src/surfaces/tui/run.ts";
import { birthCampaign } from "./campaign.ts";
import { makeTempDir, rmTempDir } from "./fs.ts";
import {
  scriptedGameMaster,
  says,
  type ScriptStep,
  type ScriptedGameMaster,
} from "./game_master.ts";

/**
 * `nq play <campaign>` end to end: the OpenTUI play client over the real
 * HomeSurface, PlaySession, PlayLoop, OMP agent, Campaign tools and a real
 * Campaign folder with git. Only the model (a scripted Game Master, or a
 * fake engine behind a real Local Inference Host), the painter, the image
 * viewer and the terminal (OpenTUI's test renderer) are fake.
 */

export const OPENING = "Mira Venn watches you from the Salt Lamp doorway.";
export const SEED = `# Seed\nYou are the Game Master of a salt-dock town.\n\n## Opening Message\n${OPENING}\n`;

/**
 * Render until a frame satisfies `ok`. The test renderer counts passes, not
 * time, and the play loop works asynchronously, so give it a time budget.
 */
export async function frameMatching(
  setup: TestRendererSetup,
  ok: (frame: string) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (ok(frame)) return frame;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`no matching frame; last frame:\n${frame}`);
    }
    await Bun.sleep(2);
  }
}

export async function until(ok: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const start = Date.now();
  while (!(await ok())) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met");
    await Bun.sleep(2);
  }
}

export type Transcript = Array<{
  role: string;
  text: string;
  ts: string;
  illustration?: string;
}>;

export async function transcript(campaign: string): Promise<Transcript> {
  const raw = await readFile(path.join(campaign, "transcript.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Transcript[number]);
}

export async function gitLog(campaign: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "log", "--format=%s"], {
    cwd: campaign,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter(Boolean);
}

export type Play = {
  setup: TestRendererSetup;
  root: string;
  campaign: string;
  /** The scripted Game Master, unless the test brought its own factory. */
  gm: ScriptedGameMaster;
  surface: HomeSurface;
  running: Promise<number>;
  /** Pictures nq play asked the image viewer to open. */
  opened: string[];
  /** Type a line into the play input and press Enter. */
  enter: (text: string) => Promise<void>;
  frame: (ok: (frame: string) => boolean) => Promise<string>;
  /**
   * Deliver SIGINT to the handlers nq play installed (Stop while turning,
   * leave while idle). The test process's own SIGINT handlers (OMP's
   * exit-on-interrupt, the test runner) are left out: they would end the run.
   */
  sigint: () => void;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Run `fn` when the current test ends, pass or fail. */
export function onCleanup(fn: () => Promise<void>): void {
  cleanups.push(fn);
}

export async function openPlay(opts: {
  steps?: ScriptStep[];
  fallback?: ScriptStep;
  /** A Game Master other than the scripted one (a local engine, say). */
  factory?: AgentSessionFactory;
  config?: Partial<NqConfig>;
  home?: Partial<HomeSurfaceOptions>;
  height?: number;
}): Promise<Play> {
  const root = await makeTempDir();
  onCleanup(() => rmTempDir(root));
  const campaign = await birthCampaign(root, { seed: SEED });
  const gm = await scriptedGameMaster({
    steps: opts.steps ?? [],
    fallback: opts.fallback ?? says("The story continues."),
  });
  const { createTestRenderer } = await import("@opentui/core/testing");
  // The play client owns SIGINT (Stop / quit); keep the fake terminal from
  // tearing itself down on it the way a real one would on a real signal.
  const setup = await createTestRenderer({
    width: 80,
    height: opts.height ?? 30,
    exitSignals: [],
  });
  const config = mergeConfig(opts.config ?? {}, {});
  const surface = new HomeSurface({
    config,
    configPath: path.join(root, "config.toml"),
    packsDir: path.join(root, "packs"),
    campaignsDir: path.join(root, "campaigns"),
    factory: opts.factory ?? gm.factory,
    ...opts.home,
  });
  const opened: string[] = [];
  const inherited = new Set(process.listeners("SIGINT"));
  const running = runPlay(surface, {
    path: campaign,
    renderer: setup.renderer,
    // the image viewer is the player's own program
    openImage: async (file) => {
      opened.push(file);
    },
  });
  onCleanup(async () => {
    await surface.leave().catch(() => {});
    setup.renderer.destroy();
  });
  const play: Play = {
    setup,
    root,
    campaign,
    gm,
    surface,
    running,
    opened,
    enter: async (text) => {
      if (text) await setup.mockInput.typeText(text);
      setup.mockInput.pressEnter();
    },
    frame: (ok) => frameMatching(setup, ok),
    sigint: () => {
      for (const listener of process.listeners("SIGINT")) {
        if (!inherited.has(listener)) listener("SIGINT");
      }
    },
  };
  await play.frame((f) => f.includes("GM  0") && f.includes("Idle"));
  return play;
}

/** A step that holds its reply until the test opens the gate. */
export function gated(): { open: () => void; wait: Promise<void> } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { open: () => resolve(), wait: promise };
}

/**
 * Wait for a Turn to be fully done: its git commit lands, then the Play Loop
 * goes Idle. The chrome shows Idle at `turn_ended`, a moment before both, and
 * a command sent in that gap is refused as busy.
 */
export async function settled(play: Play, commit: string): Promise<void> {
  await until(async () => (await gitLog(play.campaign)).includes(commit));
  await idle(play);
}

/** Wait until the Play Loop really takes commands again. */
export async function idle(play: Play): Promise<void> {
  await until(() => (play.surface.play?.loop.loopState ?? "idle") === "idle");
}

export function storyOf(frame: string): string {
  // the status line and input sit under the story
  return frame.slice(0, frame.search(/^(Idle|Turning|Memory hygiene|Rebuild)/mu));
}
