import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  readTranscript,
  SCRATCH_JSONL,
  type ScratchRecord,
} from "../../src/campaign/index.ts";
import { PlayLoop, type PlayEvent } from "../../src/play/index.ts";
import { DEFAULT_PLAY_CONFIG } from "../../src/config.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import {
  scriptedGameMaster,
  says,
  type ModelCall,
} from "../helpers/game_master.ts";

const SEED_WITH_OPENING = `# Seed

You are the Game Master of a haunted marsh.

## Opening message

Fog sits on the water.

## Memory

Keep files current.
`;

const MIRA = "---\nname: Mira\naliases: []\nkind: person\n---\nInnkeeper.\n";

async function readScratchFile(campaign: string): Promise<ScratchRecord[]> {
  const raw = await readFile(path.join(campaign, SCRATCH_JSONL), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line): ScratchRecord => JSON.parse(line));
}

/** Memory Hygiene is a hidden pass: OMP sends it as a developer message. */
function isHygiene(call: ModelCall): boolean {
  return call.instruction.startsWith("[Memory Hygiene");
}

/** The value the real `roll` tool returned to the model. */
function rolled(gm: { calls: ModelCall[] }): number {
  const hit = gm.calls
    .flatMap((c) => c.toolResults)
    .find((r) => r.name === "roll");
  return Number(hit?.text);
}

function lastLive(events: PlayEvent[]) {
  return events.filter((e) => e.type === "scratch_live").at(-1);
}

describe("Scratch capture", () => {
  test("SUCCESS writes one joinable .nq/scratch.jsonl row", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { dossiers: { x: MIRA } });
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.think("l");
            c.think("l");
            c.think("Need a dossier.");
            c.tool("read", { path: "dossiers/x.md" });
            c.tool("roll", { n: 6 });
          },
          says("Fog parts. A path appears."),
        ],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const result = await loop.turn("I step forward");
      expect(result.outcome).toBe("success");
      expect(result.playState.success_turn_count).toBe(1);
      // the model saw the real dossier and a real die
      expect(
        gm.calls[1]!.toolResults.find((r) => r.name === "read")?.text,
      ).toContain("Innkeeper.");
      const value = rolled(gm);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);

      const rows = await readTranscript(campaign);
      const gmRow = rows.find((r) => r.role === "gm");
      expect(gmRow?.text).toBe("Fog parts. A path appears.");

      const scratch = await readScratchFile(campaign);
      expect(scratch).toHaveLength(1);
      expect(scratch[0]).toEqual({
        ts: gmRow!.ts,
        turn: 1,
        thinking: "llNeed a dossier.",
        tools: [
          { name: "read", path: "dossiers/x.md" },
          { name: "roll", n: 6, value },
        ],
      });

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("local reasoning prefill remains at the start of saved Scratch", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      // a local model continues the opener inside its think block, so its
      // streamed and final thinking both start after the opener
      const gm = await scriptedGameMaster({
        provider: "llama.cpp",
        id: "local-model",
        reasoning: true,
        steps: [
          (c) => {
            c.think(" Then inspect the dossier.");
            c.say("The innkeeper watches the door.");
          },
        ],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: {
          ...DEFAULT_PLAY_CONFIG,
          model: "llama.cpp/local-model",
          localThinkingOpener:
            "First, map the relationships among everyone present.",
        },
      });
      await loop.open();
      expect((await loop.turn("I enter the tavern.")).outcome).toBe("success");

      const scratch = await readScratchFile(campaign);
      expect(scratch[0]).toMatchObject({
        thinking:
          "First, map the relationships among everyone present. Then inspect the dossier.",
      });
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("local reasoning prefill resets before every turn", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      let promptCount = 0;
      const gm = await scriptedGameMaster({
        provider: "llama.cpp",
        id: "local-model",
        reasoning: true,
        fallback: (c) => {
          promptCount += 1;
          c.think(` Thought ${promptCount}.`);
          c.say(`Turn ${promptCount}.`);
        },
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: {
          ...DEFAULT_PLAY_CONFIG,
          model: "llama.cpp/local-model",
          localThinkingOpener: "Think through this turn:",
        },
      });
      await loop.open();
      await loop.turn("First action.");
      await loop.turn("Second action.");

      const scratch = await readScratchFile(campaign);
      expect(scratch.map((record) => record.thinking)).toEqual([
        "Think through this turn: Thought 1.",
        "Think through this turn: Thought 2.",
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("hygiene and compact hidden prompts do not append scratch", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { dossiers: { x: MIRA } });
      const gm = await scriptedGameMaster({
        fallback: (c) => {
          const results = c.toolResults.length;
          if (isHygiene(c)) {
            if (results === 0) {
              c.think("hygiene think");
              return c.tool("write", {
                path: "story-beats.md",
                content: "- ranger entered marsh\n",
              });
            }
            return c.say("hygiene internal summary — discard me");
          }
          if (results === 0) {
            c.think("play think");
            return c.tool("read", { path: "dossiers/x.md" });
          }
          // the reply's prompt is past the rebuild ceiling: compaction is due
          c.usage({ input: 130_000 });
          c.say("Echo.");
        },
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 1, compactCeilingTokens: 128_000 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const result = await loop.turn("go");
      expect(result.outcome).toBe("success");
      expect(events.some((e) => e.type === "compact_ended" && e.ok)).toBe(true);

      const rows = await readTranscript(campaign);
      const gmRow = rows.find((r) => r.role === "gm");
      expect(gmRow?.text).toBe("Echo.");

      const scratch = await readScratchFile(campaign);
      expect(scratch).toHaveLength(1);
      expect(scratch[0]).toEqual({
        ts: gmRow!.ts,
        turn: 1,
        thinking: "play think",
        tools: [{ name: "read", path: "dossiers/x.md" }],
      });

      // the hidden pass really ran and really wrote memory
      expect(gm.calls.some(isHygiene)).toBe(true);
      expect(
        await readFile(path.join(campaign, "story-beats.md"), "utf8"),
      ).toBe("- ranger entered marsh\n");

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("thinking stays off the story; FAIL and opening write no scratch", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { seed: SEED_WITH_OPENING });
      const events: PlayEvent[] = [];
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.think("I will write memory.");
            c.tool("search_full", { query: "mira" });
          },
          says("She snorts."),
        ],
        // the next Turn's model stays silent, even through OMP's nudges
        fallback: () => {},
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();

      const afterOpen = await access(path.join(campaign, SCRATCH_JSONL))
        .then(() => true)
        .catch(() => false);
      expect(afterOpen).toBe(false);
      const opening = (await readTranscript(campaign)).find((r) => r.role === "gm");
      expect(opening?.text).toContain("Fog sits on the water.");

      const success = await loop.turn("I nod");
      expect(success.outcome).toBe("success");

      const prose = events
        .filter((e): e is Extract<PlayEvent, { type: "prose_delta" }> => e.type === "prose_delta")
        .map((e) => e.text)
        .join("");
      expect(prose).toBe("She snorts.");
      expect(prose).not.toContain("I will write memory.");

      const rows = await readTranscript(campaign);
      const gmRow = rows.filter((r) => r.role === "gm").at(-1);
      expect(gmRow?.text).toBe("She snorts.");
      expect(gmRow?.text).not.toContain("I will write memory.");

      const afterSuccess = await readScratchFile(campaign);
      expect(afterSuccess).toHaveLength(1);
      expect(afterSuccess[0]).toMatchObject({
        ts: gmRow!.ts,
        turn: 1,
        thinking: "I will write memory.",
        tools: [{ name: "search_full", query: "mira" }],
      });

      const fail = await loop.turn("empty please");
      expect(fail.outcome).toBe("fail");
      expect(fail.reason).toBe("empty_prose");
      expect(await readScratchFile(campaign)).toHaveLength(1);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("failed write omits wrote; parallel writes match by toolCallId", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { dossiers: { x: MIRA } });
      // Play turns have no write tools; Memory Hygiene does. Its live Scratch
      // marks only the write that landed.
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            // refused by the sandbox: existing dossiers take surgical edits
            c.tool("write", { path: "dossiers/x.md", content: "Overwritten." });
            c.tool("write", {
              path: "story-beats.md",
              content: "- Mira keeps the inn\n",
            });
          },
          says("done"),
        ],
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      expect(await loop.runHygienePass("light")).toBe(true);

      const results = gm.calls[1]!.toolResults;
      expect(results.map((r) => r.name)).toEqual(["write", "write"]);
      expect(results.some((r) => /surgical edits/.test(r.text))).toBe(true);
      expect(await readFile(path.join(campaign, "dossiers/x.md"), "utf8")).toContain(
        "Innkeeper.",
      );
      expect(await readFile(path.join(campaign, "story-beats.md"), "utf8")).toBe(
        "- Mira keeps the inn\n",
      );
      expect(lastLive(events)).toEqual({
        type: "scratch_live",
        thinking: "",
        tools: [
          { name: "write", path: "dossiers/x.md" },
          { name: "write", path: "story-beats.md", wrote: true },
        ],
      });
      // a hidden pass never appends to the saved Scratch
      const saved = await access(path.join(campaign, SCRATCH_JSONL))
        .then(() => true)
        .catch(() => false);
      expect(saved).toBe(false);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("unavailable thinking is empty; tools still recorded", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [
          (c) => c.tool("read", { path: "player_sheet.md" }),
          says("The marsh remembers."),
        ],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("look around");
      const gmRow = (await readTranscript(campaign)).find((r) => r.role === "gm");
      expect(await readScratchFile(campaign)).toEqual([
        {
          ts: gmRow!.ts,
          turn: 1,
          thinking: "",
          tools: [{ name: "read", path: "player_sheet.md" }],
        },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("streams live Scratch then persists roll n→value on SUCCESS", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      const reason = "Holding the gate: low 1-6, mid 7-14, high 15-20";
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.think("Need a number.");
            c.tool("roll", { n: 20, i: reason });
          },
          (c) => c.say(`Rolled ${c.toolResults[0]?.text}.`),
        ],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const result = await loop.turn("I roll");
      expect(result.outcome).toBe("success");
      const value = rolled(gm);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(20);

      const live = events.filter((e) => e.type === "scratch_live");
      expect(live.length).toBeGreaterThanOrEqual(3);
      expect(live[0]).toEqual({
        type: "scratch_live",
        thinking: "Need a number.",
        tools: [],
      });
      expect(live).toContainEqual({
        type: "scratch_live",
        thinking: "Need a number.",
        tools: [{ name: "roll", n: 20, reason }],
      });
      expect(live.at(-1)).toEqual({
        type: "scratch_live",
        thinking: "Need a number.",
        tools: [{ name: "roll", n: 20, value, reason }],
      });

      const gmRow = (await readTranscript(campaign)).find((r) => r.role === "gm");
      expect(gmRow?.text).toBe(`Rolled ${value}.`);
      const scratch = await readScratchFile(campaign);
      expect(scratch).toEqual([
        {
          ts: gmRow!.ts,
          turn: 1,
          thinking: "Need a number.",
          tools: [{ name: "roll", n: 20, value, reason }],
        },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("thinking_end snapshot does not double streamed thinking", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      // streamed in pieces; the provider's thinking_end repeats the whole block
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.think("Need a town.");
            c.think(" Ask where.");
            c.say("Which road?");
          },
        ],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const result = await loop.turn("I walk.");
      expect(result.outcome).toBe("success");
      expect(lastLive(events)).toEqual({
        type: "scratch_live",
        thinking: "Need a town. Ask where.",
        tools: [],
      });
      const gmRow = (await readTranscript(campaign)).find((r) => r.role === "gm");
      expect(await readScratchFile(campaign)).toEqual([
        {
          ts: gmRow!.ts,
          turn: 1,
          thinking: "Need a town. Ask where.",
          tools: [],
        },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
