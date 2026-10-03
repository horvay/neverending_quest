import { localPainter } from "@nq/local-inference/painter.ts";
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CampaignError,
  listCampaignHistory,
  listTrackedFiles,
  readTranscript,
} from "../../src/campaign/index.ts";
import {
  ILLUSTRATION_READ_TOOLS,
  PlayLoop,
  type PlayEvent,
} from "../../src/play/index.ts";
import {
  ILLUSTRATION_BTW_PREFIX,
  ILLUSTRATION_LOOKER_SYSTEM,
  illustrationAbs,
  illustrationCandidateAbs,
  illustrationRel,
} from "../../src/play/illustration.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import {
  scriptedGameMaster,
  type ModelCall,
  type ScriptedGameMaster,
} from "../helpers/game_master.ts";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PNG_OTHER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

/** What the illustration looker answers by default: a fenced tag line. */
const LOOKER_REPLY =
  "```\nmasterpiece, best quality, score_7, safe, pov, pov hands,\nfull_body, 1girl, elf, lake, laughing\n```";
/** The same prompt after the Play Loop parses it (fence, newlines, `_`). */
const LOOKER_PROMPT =
  "masterpiece, best quality, score_7, safe, pov, pov hands, full body, 1girl, elf, lake, laughing";

/** The hidden illustration lookup: its own model call, recognised by its prompt. */
function isLookup(call: ModelCall): boolean {
  return call.instruction.startsWith(ILLUSTRATION_BTW_PREFIX);
}

/**
 * The real Game Master over a scripted model. Play Turns answer `prose`; the
 * illustration looker thinks, `read`s the sheet through the real read-only
 * tools, then answers `lookup` once it has the tool result.
 */
async function illustratingGm(
  opts: { prose?: string; lookup?: string } = {},
): Promise<ScriptedGameMaster> {
  return scriptedGameMaster({
    fallback: (c) => {
      if (!isLookup(c)) return c.say(opts.prose ?? "Water hits the rocks.");
      if (c.toolResults.length === 0) {
        c.think("Looking up the people in this sitting.");
        c.tool("read", { path: "player_sheet.md" });
        return;
      }
      c.say(opts.lookup ?? LOOKER_REPLY);
    },
  });
}

/** Play session journals under the Campaign; a new play session adds one. */
async function sessionJournals(campaign: string): Promise<string[]> {
  return (await readdir(path.join(campaign, ".nq", "sessions")).catch(() => []))
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
}

/** A painter (the external image generator) that writes `png` per variant. */
function painter(png: Buffer = PNG_1x1) {
  return async ({ outPath }: { outPath: string }) => {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, png);
  };
}

async function latestGmRow(campaign: string) {
  const rows = await readTranscript(campaign);
  return [...rows].reverse().find((row) => row.role === "gm");
}

describe("Play Loop — illustrate", () => {
  test("stamps the latest GM row, writes a local PNG, commits the stamp only", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gmModel = await illustratingGm();
      const events: PlayEvent[] = [];
      let batches = 0;
      const loop = new PlayLoop({
        path: campaign,
        factory: gmModel.factory,
        onEvent: (event) => {
          events.push(event);
        },
        illustrator: { paintBatch: async ({
          seeds,
          outPaths,
          onCandidate,
        }) => {
          batches += 1;
          for (let slot = 0; slot < seeds.length; slot++) {
            const outPath = outPaths[slot]!;
            await mkdir(path.dirname(outPath), { recursive: true });
            await writeFile(outPath, PNG_1x1);
            onCandidate({ slot, seed: seeds[slot]!, path: outPath });
          }
        } },
      });
      await loop.open();
      await loop.turn("I splash her.");
      const playSession = loop.currentSession;
      const journalsAfterTurn = await sessionJournals(campaign);
      const callsAfterTurn = gmModel.calls.length;
      const before = await listCampaignHistory(campaign);
      const gm = await latestGmRow(campaign);
      expect(gm?.text).toBe("Water hits the rocks.");

      const result = await loop.illustrate();
      expect(result.ts).toBe(gm!.ts);
      expect(batches).toBe(1);
      expect(result.prompt).toBe(LOOKER_PROMPT);
      expect(events.filter((e) => e.type.startsWith("illustrate"))).toEqual([
        { type: "illustrate_started", ts: gm!.ts },
        { type: "illustrate_prompt", ts: gm!.ts, prompt: result.prompt },
        { type: "illustrate_candidate", ts: gm!.ts, slot: 0 },
        { type: "illustrate_candidate", ts: gm!.ts, slot: 1 },
        { type: "illustrate_candidate", ts: gm!.ts, slot: 2 },
        { type: "illustrate_candidate", ts: gm!.ts, slot: 3 },
        { type: "illustrate_ended", ts: gm!.ts, ok: true },
      ]);
      // the lookup is a throwaway session: the play session and its journals stay
      expect(loop.currentSession).toBe(playSession);
      expect(await sessionJournals(campaign)).toEqual(journalsAfterTurn);
      expect(loop.loopState).toBe("authoring");
      const unpicked = await readTranscript(campaign);
      expect(unpicked.find((row) => row.ts === gm!.ts)?.illustration).toBeUndefined();
      expect(
        await Bun.file(illustrationCandidateAbs(campaign, gm!.ts, 0)).exists(),
      ).toBe(true);

      // the looker saw the scene, its own system prompt, the pinned sheet, and
      // only read-only tools; its `read` really returned the sheet
      const lookup = gmModel.calls.slice(callsAfterTurn);
      expect(lookup).toHaveLength(2);
      expect(lookup.every(isLookup)).toBe(true);
      expect(lookup[0]!.instruction).toContain(
        "Current scene:\nWater hits the rocks.",
      );
      expect(lookup[0]!.system).toContain(ILLUSTRATION_LOOKER_SYSTEM);
      expect(lookup[0]!.system).toContain("A weary ranger.");
      const lookerTools = (lookup[0]!.context.tools ?? []).map((t) => t.name);
      expect(lookerTools).toContain("read");
      expect(
        lookerTools.every((name) =>
          (ILLUSTRATION_READ_TOOLS as readonly string[]).includes(name),
        ),
      ).toBe(true);
      expect(lookup[1]!.toolResults[0]?.name).toBe("read");
      expect(lookup[1]!.toolResults[0]?.text).toContain("A weary ranger.");

      await loop.pickIllustration(0);
      expect(events.filter((e) => e.type === "illustrate_picked")).toEqual([
        { type: "illustrate_picked", ts: gm!.ts, slot: 0 },
      ]);

      const stamped = await readTranscript(campaign);
      const stampedGm = stamped.find((row) => row.ts === gm!.ts);
      expect(stampedGm?.illustration).toBe(gm!.ts);
      expect(stampedGm?.illustrationPrompt).toBe(result.prompt);

      const rel = illustrationRel(gm!.ts);
      expect(await Bun.file(path.join(campaign, rel)).exists()).toBe(true);

      const history = await listCampaignHistory(campaign);
      expect(history).toHaveLength(before.length + 1);
      expect(history[0]?.message).toBe("illustrate");
      const tracked = await listTrackedFiles(campaign);
      expect(tracked.some((f) => f.startsWith("illustrations/"))).toBe(false);

      const story = await loop.snapshotStory();
      expect(story.some((b) => b.illustration === gm!.ts)).toBe(true);
      expect(
        story.find((b) => b.illustration === gm!.ts)?.illustrationPrompt,
      ).toBe(result.prompt);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("refuses a missing runner and a missing GM row", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const emptyTools = path.join(root, "no-tools");
      await mkdir(emptyTools);
      const gmModel = await illustratingGm({ prose: "ok" });
      const loop = new PlayLoop({
        path: campaign,
        factory: gmModel.factory,
        illustrator: localPainter({ animaDir: emptyTools }),
      });
      await loop.open();
      const status = await loop.illustrationStatus();
      expect(status.ready).toBe(false);

      await expect(loop.illustrate()).rejects.toBeInstanceOf(CampaignError);
      try {
        await loop.illustrate();
      } catch (err) {
        expect((err as CampaignError).code).toBe("unavailable");
      }
      await loop.close();

      const ready = new PlayLoop({
        path: campaign,
        factory: gmModel.factory,
        illustrator: { paintOne: async () => {} },
      });
      await ready.open();
      try {
        await ready.illustrate();
        throw new Error("expected not_found");
      } catch (err) {
        expect((err as CampaignError).code).toBe("not_found");
      }
      expect(ready.loopState).toBe("idle");
      // neither refusal reached the model
      expect(gmModel.calls).toHaveLength(0);
      await ready.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("garbage rewrite does not write a PNG", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gmModel = await illustratingGm({
        lookup: "Sure, I can help with that.",
      });
      const events: PlayEvent[] = [];
      let wrote = false;
      const loop = new PlayLoop({
        path: campaign,
        factory: gmModel.factory,
        onEvent: (event) => {
          events.push(event);
        },
        illustrator: { paintOne: async () => {
          wrote = true;
        } },
      });
      await loop.open();
      await loop.turn("I splash her.");
      try {
        await loop.illustrate();
        throw new Error("expected bad_prompt");
      } catch (err) {
        expect((err as CampaignError).code).toBe("bad_prompt");
      }
      expect(wrote).toBe(false);
      const illust = events.filter((e) => e.type.startsWith("illustrate"));
      expect(illust[0]?.type).toBe("illustrate_started");
      expect(illust.some((e) => e.type === "illustrate_prompt")).toBe(false);
      expect(illust.at(-1)).toMatchObject({ type: "illustrate_ended", ok: false });
      expect(loop.loopState).toBe("idle");
      const rows = await readTranscript(campaign);
      expect(rows.some((row) => row.illustration)).toBe(false);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("a model error in the lookup is generate_failed and restores Idle", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gmModel = await scriptedGameMaster({
        fallback: (c) => {
          // not a transient-sounding error: OMP retries those with backoff
          if (isLookup(c)) throw new Error("lookup model refused the request");
          c.say("Water hits the rocks.");
        },
      });
      let painted = 0;
      const loop = new PlayLoop({
        path: campaign,
        factory: gmModel.factory,
        illustrator: { paintOne: async (args) => {
          painted += 1;
          await painter()(args);
        } },
      });
      await loop.open();
      await loop.turn("I splash her.");
      const err = await loop.illustrate().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("generate_failed");
      expect((err as CampaignError).message).toContain("lookup model refused the request");
      expect(painted).toBe(0);
      expect(loop.loopState).toBe("idle");
      // the play session is unharmed: the next Turn still plays
      expect((await loop.turn("Again.")).outcome).toBe("success");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("overlapping illustrate cannot both pass Idle", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gate = Promise.withResolvers<void>();
      const painting = Promise.withResolvers<void>();
      const gmModel = await illustratingGm();
      const loop = new PlayLoop({
        path: campaign,
        factory: gmModel.factory,
        illustrator: { paintOne: async (args) => {
          painting.resolve();
          await gate.promise;
          await painter()(args);
        } },
      });
      await loop.open();
      await loop.turn("I splash her.");

      const first = loop.illustrate();
      expect(loop.loopState).toBe("authoring");
      await painting.promise;
      expect(loop.loopState).toBe("authoring");

      try {
        await loop.illustrate();
        throw new Error("expected busy");
      } catch (err) {
        expect(err).toBeInstanceOf(CampaignError);
        expect((err as CampaignError).code).toBe("busy");
      }

      gate.resolve();
      await first;
      expect(loop.loopState).toBe("authoring");
      await loop.pickIllustration(0);
      expect(loop.loopState).toBe("idle");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("re-click replaces the PNG for the same GM ts and stays untracked", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      let writes = 0;
      const gmModel = await illustratingGm();
      const loop = new PlayLoop({
        path: campaign,
        factory: gmModel.factory,
        illustrator: { paintOne: async (args) => {
          writes += 1;
          await painter(writes === 1 ? PNG_1x1 : PNG_OTHER)(args);
        } },
      });
      await loop.open();
      await loop.turn("I splash her.");
      const playSession = loop.currentSession;
      const journalsAfterTurn = await sessionJournals(campaign);
      const gm = await latestGmRow(campaign);
      expect(gm).toBeTruthy();

      const first = await loop.illustrate();
      expect(first.ts).toBe(gm!.ts);
      await loop.pickIllustration(0);
      const abs = illustrationAbs(campaign, gm!.ts);
      expect(Buffer.from(await Bun.file(abs).arrayBuffer()).equals(PNG_1x1)).toBe(
        true,
      );

      const second = await loop.illustrate();
      expect(second.ts).toBe(gm!.ts);
      expect(writes).toBe(8);
      await loop.pickIllustration(0);
      expect(
        Buffer.from(await Bun.file(abs).arrayBuffer()).equals(PNG_OTHER),
      ).toBe(true);

      const stamped = await readTranscript(campaign);
      expect(stamped.find((row) => row.ts === gm!.ts)?.illustration).toBe(gm!.ts);
      const tracked = await listTrackedFiles(campaign);
      expect(tracked.some((f) => f.startsWith("illustrations/"))).toBe(false);
      expect(loop.currentSession).toBe(playSession);
      expect(await sessionJournals(campaign)).toEqual(journalsAfterTurn);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("given prompt skips the rewrite and stamps that line", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gmModel = await illustratingGm();
      const painted: string[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gmModel.factory,
        illustrator: { paintOne: async (args) => {
          painted.push(args.prompt);
          await painter()(args);
        } },
      });
      await loop.open();
      await loop.turn("I splash her.");
      const callsBefore = gmModel.calls.length;
      const given =
        "pov, pov hands, cowboy_shot, 1girl, elf, lake, night, laughing";
      const result = await loop.illustrate({ prompt: given });
      expect(result.prompt).toBe(
        "pov, pov hands, cowboy shot, 1girl, elf, lake, night, laughing",
      );
      expect(painted).toEqual(Array(4).fill(result.prompt));
      // no lookup: the model was not called
      expect(gmModel.calls.length).toBe(callsBefore);
      await loop.pickIllustration(0);
      const gm = await latestGmRow(campaign);
      expect(gm?.illustrationPrompt).toBe(result.prompt);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("paints four variants with distinct seeds", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const seeds: number[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: (await illustratingGm()).factory,
        illustrator: { paintOne: async (args) => {
          seeds[args.slot] = args.seed;
          await painter()(args);
        } },
      });
      await loop.open();
      await loop.turn("I splash her.");
      await loop.illustrate();
      expect(seeds).toHaveLength(4);
      expect(new Set(seeds).size).toBe(4);
      expect(seeds.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
      await loop.cancelIllustration();
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("lookup scratch is live before the variants are painted", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      let liveBeforePaint = -1;
      const loop = new PlayLoop({
        path: campaign,
        factory: (await illustratingGm()).factory,
        onEvent: (event) => {
          events.push(event);
        },
        illustrator: { paintOne: async (args) => {
          if (liveBeforePaint < 0) {
            liveBeforePaint = events.filter((e) => e.type === "scratch_live").length;
          }
          await painter()(args);
        } },
      });
      await loop.open();
      await loop.turn("I splash her.");
      const sinceTurn = events.length;
      await loop.illustrate();
      const live = events.slice(sinceTurn).filter((e) => e.type === "scratch_live");
      expect(live.length).toBeGreaterThan(0);
      expect(liveBeforePaint).toBeGreaterThan(0);
      expect(
        live.some(
          (e) =>
            e.type === "scratch_live" &&
            e.thinking.includes("Looking up the people in this sitting."),
        ),
      ).toBe(true);
      expect(
        live.some(
          (e) =>
            e.type === "scratch_live" && e.tools.some((t) => t.name === "read"),
        ),
      ).toBe(true);
      await loop.cancelIllustration();
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("cancel drops variants and does not stamp", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const loop = new PlayLoop({
        path: campaign,
        factory: (await illustratingGm()).factory,
        illustrator: { paintOne: painter() },
      });
      await loop.open();
      await loop.turn("I splash her.");
      const gm = await latestGmRow(campaign);
      const before = await listCampaignHistory(campaign);
      await loop.illustrate();
      await loop.cancelIllustration();
      expect(loop.loopState).toBe("idle");
      const after = await readTranscript(campaign);
      expect(after.find((row) => row.ts === gm!.ts)?.illustration).toBeUndefined();
      expect(
        await Bun.file(illustrationAbs(campaign, gm!.ts)).exists(),
      ).toBe(false);
      for (let slot = 0; slot < 4; slot++) {
        expect(
          await Bun.file(illustrationCandidateAbs(campaign, gm!.ts, slot)).exists(),
        ).toBe(false);
      }
      expect(await listCampaignHistory(campaign)).toEqual(before);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("generate_failed does not stamp and restores Idle", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const loop = new PlayLoop({
        path: campaign,
        factory: (await illustratingGm()).factory,
        illustrator: { paintBatch: async () => {
          throw new Error("sd-cli exploded");
        } },
      });
      await loop.open();
      await loop.turn("I splash her.");
      try {
        await loop.illustrate();
        throw new Error("expected generate_failed");
      } catch (err) {
        expect(err).toBeInstanceOf(CampaignError);
        expect((err as CampaignError).code).toBe("generate_failed");
        expect((err as CampaignError).message).toBe("sd-cli exploded");
      }
      expect(loop.loopState).toBe("idle");
      const rows = await readTranscript(campaign);
      expect(rows.some((row) => row.illustration)).toBe(false);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("paints through a chatty sd-cli picked from the Anima folder", async () => {
    const root = await makeTempDir();
    try {
      // the image generator is external: a fake sd-cli that floods stdout
      // (a piped stdout would deadlock it) and records its arguments
      const anima = path.join(root, "anima");
      await mkdir(anima);
      const cli = path.join(anima, "sd-cli");
      await writeFile(
        cli,
        `#!/bin/sh
printf '%s\\n' "$@" >> "${root}/args.txt"
printf '%s\\n' "--end--" >> "${root}/args.txt"
dd if=/dev/zero bs=65536 count=16 2>/dev/null
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
    break
  fi
  prev="$arg"
done
mkdir -p "$(dirname "$out")"
printf 'ok' > "$out"
`,
      );
      await chmod(cli, 0o755);
      // a non-Anima GGUF too: the Anima diffusion model must win
      await writeFile(path.join(anima, "other.gguf"), "no");
      await writeFile(path.join(anima, "anima-turbo-v1.1-Q8_0.gguf"), "anima");
      await writeFile(path.join(anima, "qwen_3_06b_base.safetensors"), "enc");
      await writeFile(path.join(anima, "qwen_image_vae.safetensors"), "vae");

      const campaign = await birthCampaign(root);
      const loop = new PlayLoop({
        path: campaign,
        factory: (await illustratingGm()).factory,
        illustrator: localPainter({ animaDir: anima }),
      });
      await loop.open();
      expect((await loop.illustrationStatus()).ready).toBe(true);
      await loop.turn("I splash her.");
      const gm = await latestGmRow(campaign);
      const result = await Promise.race([
        loop.illustrate(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("sd-cli hung on stdout")), 5_000);
        }),
      ]);
      expect(result.prompt).toBe(LOOKER_PROMPT);
      for (let slot = 0; slot < 4; slot++) {
        expect(
          await Bun.file(illustrationCandidateAbs(campaign, gm!.ts, slot)).text(),
        ).toBe("ok");
      }

      const runs = (await Bun.file(path.join(root, "args.txt")).text())
        .split("--end--\n")
        .filter((run) => run.trim())
        .map((run) => run.trimEnd().split("\n"));
      expect(runs).toHaveLength(4);
      const args = runs[0]!;
      const flag = (name: string) => args[args.indexOf(name) + 1];
      expect(flag("--diffusion-model")).toBe(
        path.join(anima, "anima-turbo-v1.1-Q8_0.gguf"),
      );
      expect(flag("--llm")).toBe(path.join(anima, "qwen_3_06b_base.safetensors"));
      expect(flag("--vae")).toBe(path.join(anima, "qwen_image_vae.safetensors"));
      expect(flag("-p")).toBe(LOOKER_PROMPT);
      expect(args).toContain("--offload-to-cpu");
      expect(new Set(runs.map((run) => run[run.indexOf("-s") + 1])).size).toBe(4);
      const negative = flag("--negative-prompt")!.split(", ");
      expect(negative).toContain("worst quality");
      expect(negative).toContain("child");
      for (const exclusion of [
        "close-up", "portrait", "face focus", "twins", "siblings", "sisters",
        "clone", "identical", "extra girls", "3girls",
      ]) {
        expect(negative).not.toContain(exclusion);
      }

      await loop.pickIllustration(3);
      expect(await Bun.file(illustrationAbs(campaign, gm!.ts)).text()).toBe("ok");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
