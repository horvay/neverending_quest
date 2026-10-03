import { describe, expect, test } from "bun:test";
import { appendFile, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadPlayState,
  newCampaign,
  readTranscript,
} from "../../src/campaign/index.ts";
import {
  buildHistoryHandoff,
  MissingSeedError,
  PlayLoop,
  SESSION_TOOL_NAMES,
  type PlayEvent,
} from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir, writePack } from "../helpers/fs.ts";
import {
  scriptedGameMaster,
  says,
  type ModelCall,
} from "../helpers/game_master.ts";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : ""))
    .join("");
}

/** What the model was sent, as [role, text] pairs. */
function dialogue(call: ModelCall): Array<[string, string]> {
  return call.context.messages.map((m) => [
    m.role,
    textOf((m as { content?: unknown }).content),
  ]);
}

/** OMP session journals the Play Loop left under the Campaign. */
async function journalFiles(campaign: string): Promise<string[]> {
  const dir = path.join(campaign, ".nq", "sessions");
  return (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => path.join(dir, f));
}

describe("Play Loop — scripted Turn", () => {
  test("SUCCESS appends player+gm transcript rows and bumps success_turn_count", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      const gm = await scriptedGameMaster({
        steps: [says("Fog parts. A path appears.")],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      expect(loop.loopState).toBe("idle");

      const result = await loop.turn("I step forward");
      expect(result.outcome).toBe("success");
      expect(result.prose).toBe("Fog parts. A path appears.");
      expect(result.playState.success_turn_count).toBe(1);
      expect(gm.calls.map((c) => c.prompt)).toEqual(["I step forward"]);

      const rows = await readTranscript(campaign);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ role: "player", text: "I step forward" });
      expect(rows[1]).toMatchObject({
        role: "gm",
        text: "Fog parts. A path appears.",
      });

      const ps = await loadPlayState(campaign);
      expect(ps.success_turn_count).toBe(1);

      expect(events.some((e) => e.type === "turn_started")).toBe(true);
      expect(events.some((e) => e.type === "prose_delta")).toBe(true);
      expect(
        events.some((e) => e.type === "turn_ended" && e.outcome === "success"),
      ).toBe(true);
      const log = await Bun.$`git -C ${campaign} log --format=%s`.quiet().text();
      expect(log.split("\n")[0]).toBe("turn 1");

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("FAIL on empty prose: no gm row, counter unchanged", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ steps: [says("   ")] });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const result = await loop.turn("hello");
      expect(result.outcome).toBe("fail");
      expect(result.reason).toBe("empty_prose");

      const rows = await readTranscript(campaign);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe("player");
      expect((await loadPlayState(campaign)).success_turn_count).toBe(0);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  // KNOWN PRODUCT BUG (same as edges.test.ts): a provider error on a play
  // Turn reaches the Play Loop as empty prose, so the Turn FAILs as
  // `empty_prose` instead of `agent_error`. `test.failing` flags the fix.
  test.failing("FAIL on agent error keeps counter and player row only", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [
          () => {
            throw new Error("provider down");
          },
        ],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const result = await loop.turn("x");
      expect(result.outcome).toBe("fail");
      expect((await readTranscript(campaign)).map((r) => r.role)).toEqual([
        "player",
      ]);
      expect((await loadPlayState(campaign)).success_turn_count).toBe(0);
      expect(result.reason).toBe("agent_error");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("missing seed.md hard-fails open before Idle", async () => {
    const root = await makeTempDir();
    try {
      const pack = path.join(root, "pack");
      const campaign = path.join(root, "noseed");
      await writePack(pack, {
        "seed.md": "will delete\n",
        "player_sheet.md":
          "## Description\n\n## Inventory\n\n## Powers\n\n## Notes\n",
      });
      await newCampaign({ path: campaign, packDir: pack });
      await unlink(path.join(campaign, "seed.md"));

      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      let err: unknown;
      try {
        await loop.open();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MissingSeedError);
      expect(loop.loopState).toBe("closed");
      // no Game Master session was started
      expect(await journalFiles(campaign)).toEqual([]);
      expect(gm.calls).toHaveLength(0);
    } finally {
      await rmTempDir(root);
    }
  });

  test("factory receives Context prime on create (voice + seed + pins)", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        world: "Ash Court rules the ridge.\n",
        dossiers: {
          "mira.md": "---\nname: Mira\nkind: person\n---\nGuide.\n",
        },
      });
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("I look around.");

      // what the model is actually sent on the first Turn
      const system = gm.calls[0]!.system;
      const voice = await readFile(
        new URL("../../src/play/gm_voice.md", import.meta.url),
        "utf8",
      );
      expect(system.startsWith(voice.trim())).toBe(true);
      expect(system).toContain("# The Scenario\n\n# Seed");
      expect(system).toContain("## Runtime infrastructure");
      for (const pin of [
        "player_sheet.md",
        "world-building.md",
        "quest-log.md",
        "story-beats.md",
      ]) {
        expect(system).toContain(`<file path="${pin}">`);
      }
      expect(system).toContain("Ash Court rules the ridge.");
      // the dossier catalog pins the front matter only
      expect(system).toContain('<file path="dossiers/mira.md:1-4">');
      expect(system).not.toContain("Guide.");
      // pins travel in the system prompt, not as chat messages
      expect(dialogue(gm.calls[0]!)).toEqual([["user", "I look around."]]);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  // OMP reads "search" as its legacy alias for the stock "grep", so the
  // Campaign tool only survives if the session never re-selects its tools
  test("the Game Master is offered every session tool, search included", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [
          (c) => c.tool("search", { query: "ranger" }),
          says("ok"),
        ],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("I look around.");
      await loop.close();
      expect(gm.calls[0]!.context.tools?.map((t) => t.name).sort()).toEqual(
        [...SESSION_TOOL_NAMES].sort(),
      );
      expect(gm.calls[1]!.toolResults[0]?.text).toContain("player_sheet.md");
    } finally {
      await rmTempDir(root);
    }
  });

  test("resume reloads Context Assembly and preserves conversation history", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const voicePath = path.join(root, "gm-voice.md");
      await writeFile(voicePath, "FIRST VOICE\n", "utf8");
      const gm = await scriptedGameMaster({
        steps: [says("The old reply.")],
        fallback: says("The new reply."),
      });
      const config = {
        gmVoicePath: voicePath,
        gmPersonality: "Patient and severe.",
      };

      const loop1 = new PlayLoop({ path: campaign, factory: gm.factory, config });
      await loop1.open();
      await loop1.turn("Remember this exchange.");
      await loop1.close();
      const journals = await journalFiles(campaign);
      expect(journals).toHaveLength(1);

      await writeFile(voicePath, "CURRENT VOICE\n", "utf8");
      await writeFile(path.join(campaign, "seed.md"), "# Current seed\nThe bridge is burning.\n");
      await writeFile(
        path.join(campaign, "player_sheet.md"),
        "## Description\nScarred.\n\n## Inventory\nA brass key.\n\n## Powers\n\n## Notes\n",
      );

      const loop2 = new PlayLoop({ path: campaign, factory: gm.factory, config });
      await loop2.open();
      // resumed the persisted OMP session instead of priming a new one
      expect(loop2.hasPrimedSession).toBe(false);
      await loop2.turn("And now?");
      expect(await journalFiles(campaign)).toEqual(journals);

      const resumed = gm.calls.at(-1)!;
      expect(dialogue(resumed)).toEqual([
        ["user", "Remember this exchange."],
        ["assistant", "The old reply."],
        ["user", "And now?"],
      ]);
      expect(resumed.system.startsWith("CURRENT VOICE")).toBe(true);
      expect(resumed.system).toContain("Patient and severe.");
      expect(resumed.system).toContain("# Current seed");
      expect(resumed.system).toContain("## Runtime infrastructure");
      expect(resumed.system).toContain("A brass key.");
      expect(resumed.system).not.toContain("FIRST VOICE");
      await loop2.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("rejected private history is rebuilt from the player-facing transcript", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [says("The bridge is open.")],
        fallback: says("You cross the bridge."),
      });
      const first = new PlayLoop({ path: campaign, factory: gm.factory });
      await first.open();
      await first.turn("I unlock the bridge.");
      await first.close();

      // the private history ends mid hidden pass (as after a crash): marked
      // dirty, so it must not be resumed
      const [journal] = await journalFiles(campaign);
      const lines = (await readFile(journal!, "utf8")).trim().split("\n");
      const lastId = JSON.parse(lines.at(-1)!).id as string;
      await appendFile(
        journal!,
        `${JSON.stringify({
          type: "custom",
          customType: "nq-hidden-history-isolation",
          data: { state: "dirty" },
          id: "d1d1d1d1",
          parentId: lastId,
          timestamp: new Date().toISOString(),
        })}\n`,
      );

      const transcript = await readTranscript(campaign);
      const resumed = new PlayLoop({ path: campaign, factory: gm.factory });
      try {
        await resumed.open();
        expect(resumed.hasPrimedSession).toBe(true);
        expect((await resumed.turn("I cross.")).outcome).toBe("success");
        const seeded = dialogue(gm.calls.at(-1)!);
        expect(seeded.slice(0, transcript.length)).toEqual(
          transcript.map((row): [string, string] => [
            row.role === "player" ? "user" : "assistant",
            row.text,
          ]),
        );
        expect(seeded.slice(transcript.length, -1).map(([, t]) => t)).toEqual([
          buildHistoryHandoff("full"),
        ]);
        expect(seeded.at(-1)).toEqual(["user", "I cross."]);
        // a new root journal replaced the rejected one
        expect(await journalFiles(campaign)).toHaveLength(2);
        expect((await readTranscript(campaign)).slice(0, 2)).toEqual(transcript);
      } finally {
        await resumed.close();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("create and continueRecent receive Campaign sandbox", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      await writeFile(path.join(root, "secret.txt"), "outside the Campaign\n");
      // each Turn the Game Master reads its sheet and tries to escape
      const probe = [
        (c: ModelCall) => {
          c.tool("read", { path: "player_sheet.md" });
          c.tool("read", { path: "../secret.txt" });
        },
        says("ok"),
      ];
      const gm = await scriptedGameMaster({ steps: [...probe, ...probe] });

      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      expect(loop.hasPrimedSession).toBe(true);
      await loop.turn("hi");
      await loop.close();

      // Second open resumes the persisted session; still jailed.
      const loop2 = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop2.open();
      expect(loop2.hasPrimedSession).toBe(false);
      await loop2.turn("again");
      await loop2.close();

      for (const call of [gm.calls[1]!, gm.calls[3]!]) {
        const texts = call.toolResults.map((r) => r.text);
        expect(texts).toHaveLength(2);
        expect(texts.some((t) => t.includes("A weary ranger."))).toBe(true);
        expect(texts.some((t) => t.includes("Path escapes Campaign folder"))).toBe(
          true,
        );
        expect(texts.some((t) => t.includes("outside the Campaign"))).toBe(false);
      }
    } finally {
      await rmTempDir(root);
    }
  });
});
