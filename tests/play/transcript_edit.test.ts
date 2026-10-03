import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import {
  appendScratchRecord,
  appendTranscriptRow,
  CampaignError,
  commitCampaign,
  deleteLastTranscript,
  listCampaignHistory,
  readScratch,
  readTranscript,
  savePlayState,
  SCRATCH_JSONL,
  STORY_BEATS_MD,
} from "../../src/campaign/index.ts";
import {
  buildContextPrime,
  buildHistoryHandoff,
  estimateTokensDefault,
  PlayLoop,
  PinOverflowError,
  playSessionLayer,
  withPlaySession,
  type PlayEvent,
} from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import {
  scriptedGameMaster,
  says,
  type ModelCall,
} from "../helpers/game_master.ts";

type Seed = { role: string; content: string };
type Journal = { file: string; seeds: Seed[]; exited: boolean };

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p as { text?: string }).text ?? "").join("\n");
}

/**
 * The OMP session journals under the Campaign's `.nq/sessions/`, oldest
 * first. A rebuilt session is a new journal whose history OMP recorded before
 * any prompt (the seed: transcript rows plus the handoff, which OMP carries as
 * a `developer` message); a session the Play Loop ended records its exit.
 */
async function journals(campaign: string): Promise<Journal[]> {
  const dir = path.join(campaign, ".nq", "sessions");
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const out: Journal[] = [];
  for (const file of files) {
    const entries = (await readFile(path.join(dir, file), "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const seeds: Seed[] = [];
    for (const entry of entries) {
      // the first prompt (or hidden-pass guard) ends the seeded history
      if (entry.type === "custom") break;
      if (entry.type !== "message") continue;
      const message = entry.message as { role: string; content: unknown };
      seeds.push({ role: message.role, content: contentText(message.content) });
    }
    const exited = entries.some(
      (e) => e.type === "custom" && e.customType === "session_exit",
    );
    out.push({ file, seeds, exited });
  }
  return out;
}

/** Every message sent on this call, as role and text. */
function history(call: ModelCall): Seed[] {
  return (call.context.messages ?? []).map((m) => ({
    role: m.role as string,
    content: contentText((m as { content?: unknown }).content),
  }));
}

/** Text of every message the model was sent on this call. */
function sentTexts(call: ModelCall): string[] {
  return (call.context.messages ?? []).map((m) =>
    contentText((m as { content?: unknown }).content),
  );
}

/** Memory Hygiene is a hidden pass: OMP sends it as a developer message. */
function isHygiene(call: ModelCall): boolean {
  return call.instruction.startsWith("[Memory Hygiene");
}

/** What the real prime (system prompt plus pins) costs by the real estimator. */
async function pinTokens(campaign: string): Promise<number> {
  const prime = await buildContextPrime(campaign, {
    compactCeilingTokens: 128_000,
    completionReserveTokens: 0,
  });
  return prime.estimatedTokens;
}

const SEED_WITH_OPENING = `# Voice

Speak sparsely.

## Opening message

Dust lifts off the arena stones.

## Memory

Keep files current.
`;

describe("Play Loop — transcript edit / delete", () => {
  test("edit mid-log commits, keeps later rows, and replaces the session", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      await Bun.write(path.join(campaign, STORY_BEATS_MD), "- old beat\n");
      const gm = await scriptedGameMaster({
        fallback: says("Fog parts. A path appears."),
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("I step forward");
      await loop.turn("I keep walking");
      const before = await listCampaignHistory(campaign);
      const session = loop.currentSession;
      const journalsBefore = await journals(campaign);
      const rows = await readTranscript(campaign);
      const mid = rows[0]!;
      expect(mid.role).toBe("player");

      const edited = await loop.editTranscript(mid.ts, "I step onto the dock.");
      expect(edited.ts).toBe(mid.ts);
      expect(edited.role).toBe("player");
      expect(edited.text).toBe("I step onto the dock.");

      const after = await readTranscript(campaign);
      expect(after).toHaveLength(4);
      expect(after[0]).toEqual(edited);
      expect(after[1]?.text).toBe("Fog parts. A path appears.");
      expect(after[2]?.text).toBe("I keep walking");
      expect(after[3]?.text).toBe("Fog parts. A path appears.");
      expect(await readFile(path.join(campaign, STORY_BEATS_MD), "utf8")).toBe(
        "- old beat\n",
      );

      const history = await listCampaignHistory(campaign);
      expect(history).toHaveLength(before.length + 1);
      expect(history[0]?.message).toBe("edit");

      // the old OMP session was ended and a new one seeded from the edit
      expect(loop.currentSession).not.toBe(session);
      expect(loop.hasPrimedSession).toBe(true);
      const after_ = await journals(campaign);
      expect(after_).toHaveLength(journalsBefore.length + 1);
      expect(after_[0]!.exited).toBe(true);
      const rebuilt = after_.at(-1)!;
      expect(rebuilt.seeds.some((m) => m.content === "I step onto the dock.")).toBe(
        true,
      );
      expect(rebuilt.seeds.some((m) => m.content === "I step forward")).toBe(false);
      expect(rebuilt.seeds.at(-1)).toEqual({
        role: "developer",
        content: buildHistoryHandoff("full"),
      });

      // the next Turn's model reads the edited history
      await loop.turn("I look back");
      const sent = sentTexts(gm.calls.at(-1)!);
      expect(sent).toContain("I step onto the dock.");
      expect(sent).not.toContain("I step forward");

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("edit opening GM row commits and replaces the session", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { seed: SEED_WITH_OPENING });
      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const opening = (await readTranscript(campaign))[0]!;
      expect(opening.role).toBe("gm");
      expect(opening.text).toContain("Dust lifts");
      const session = loop.currentSession;
      const before = await listCampaignHistory(campaign);

      const edited = await loop.editTranscript(
        opening.ts,
        "Dust hangs over the stones.",
      );
      expect(edited.ts).toBe(opening.ts);
      expect(edited.role).toBe("gm");
      expect((await readTranscript(campaign))[0]?.text).toBe(
        "Dust hangs over the stones.",
      );
      expect((await listCampaignHistory(campaign))[0]?.message).toBe("edit");
      expect((await listCampaignHistory(campaign)).length).toBe(before.length + 1);
      expect(loop.currentSession).not.toBe(session);
      expect((await journals(campaign)).at(-1)!.seeds).toEqual([
        { role: "assistant", content: "Dust hangs over the stones." },
        { role: "developer", content: buildHistoryHandoff("full") },
      ]);
      expect(gm.calls).toHaveLength(0);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("delete last pair rewinds the tree, prunes scratch, and replaces the session", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: (c) => {
          c.think("plan");
          c.say("The marsh answers.");
        },
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("first");
      await loop.turn("second");
      const beforeRows = await readTranscript(campaign);
      expect(beforeRows).toHaveLength(4);
      const scratchBefore = await readScratch(campaign);
      expect(scratchBefore).toHaveLength(2);
      const lastGm = beforeRows[3]!;
      const session = loop.currentSession;
      const before = await listCampaignHistory(campaign);

      const deleted = await loop.deleteTranscript(lastGm.ts);
      expect(deleted.map((r) => r.role)).toEqual(["player", "gm"]);
      expect(deleted[1]?.ts).toBe(lastGm.ts);

      const after = await readTranscript(campaign);
      expect(after).toEqual(beforeRows.slice(0, 2));
      const scratchAfter = await readScratch(campaign);
      expect(scratchAfter).toHaveLength(1);
      expect(scratchAfter[0]?.ts).toBe(beforeRows[1]!.ts);
      expect(scratchAfter.some((r) => r.ts === lastGm.ts)).toBe(false);

      const history = await listCampaignHistory(campaign);
      expect(history.some((c) => c.message === "turn 2")).toBe(false);
      expect(history[0]?.message).toBe("turn 1");
      expect(history.length).toBeLessThan(before.length);
      expect(loop.currentPlayState.success_turn_count).toBe(1);
      expect(loop.currentSession).not.toBe(session);
      expect(loop.hasPrimedSession).toBe(true);
      const js = await journals(campaign);
      expect(js[0]!.exited).toBe(true);
      const seed = js.at(-1)!.seeds;
      expect(seed.some((m) => m.content === "first")).toBe(true);
      expect(seed.some((m) => m.content === "second")).toBe(false);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("delete keeps the next Turn below the context ceiling", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const rowText = "x".repeat(3_300);
      for (let turn = 0; turn < 101; turn++) {
        await appendTranscriptRow(campaign, {
          role: "player",
          text: rowText,
          ts: new Date(Date.UTC(2026, 0, 1, 0, 0, turn * 2)).toISOString(),
        });
        await appendTranscriptRow(campaign, {
          role: "gm",
          text: rowText,
          ts: new Date(Date.UTC(2026, 0, 1, 0, 0, turn * 2 + 1)).toISOString(),
        });
      }
      let observedContextTokens = 0;
      // the provider rejects a prompt past its window, as a real one does
      const gm = await scriptedGameMaster({
        fallback: (c) => {
          observedContextTokens = sentTexts(c).reduce(
            (tokens, text) => tokens + estimateTokensDefault(text),
            estimateTokensDefault(c.system),
          );
          if (observedContextTokens > 128_000) {
            throw new Error(`context is ${observedContextTokens} tokens`);
          }
          c.say("The road opens.");
        },
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();

      await loop.deleteTranscript();
      const result = await loop.turn("A new choice.");

      expect(observedContextTokens).toBeGreaterThan(0);
      expect(observedContextTokens).toBeLessThanOrEqual(128_000);
      expect(result.outcome).toBe("success");
      expect(gm.calls.at(-1)?.prompt).toBe("A new choice.");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("delete last pair restores dossier, beats, and a fresh session seed", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        dossiers: {
          "mira-venn":
            "---\nname: Mira Venn\naliases: []\nkind: person\n---\nInnkeeper.\n",
        },
      });
      await Bun.write(path.join(campaign, STORY_BEATS_MD), "- old beat\n");
      // Memory Hygiene after each Turn; after Turn two it archives Mira and
      // logs a beat through the real archive and write tools
      let memoryChanges = false;
      const gm = await scriptedGameMaster({
        fallback: (c) => {
          if (!isHygiene(c)) return c.say("The marsh answers.");
          if (memoryChanges && c.toolResults.length === 0) {
            c.tool("archive", { slug: "mira-venn" });
            c.tool("write", {
              path: STORY_BEATS_MD,
              content: "- old beat\n- later beat from turn two\n",
            });
            return;
          }
          c.say("notes kept");
        },
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 1 },
      });
      await loop.open();
      expect((await loop.turn("one")).outcome).toBe("success");
      const miraAfterOne = await readFile(
        path.join(campaign, "dossiers", "mira-venn.md"),
        "utf8",
      );
      memoryChanges = true;
      expect((await loop.turn("two")).outcome).toBe("success");
      expect(
        await Bun.file(path.join(campaign, "dossiers", "mira-venn.md")).exists(),
      ).toBe(false);
      expect(
        await Bun.file(
          path.join(campaign, "dossiers", "archive", "mira-venn.md"),
        ).exists(),
      ).toBe(true);
      expect(await readFile(path.join(campaign, STORY_BEATS_MD), "utf8")).toContain(
        "later beat",
      );

      await loop.deleteTranscript();

      expect(
        await readFile(path.join(campaign, "dossiers", "mira-venn.md"), "utf8"),
      ).toBe(miraAfterOne);
      expect(
        await Bun.file(
          path.join(campaign, "dossiers", "archive", "mira-venn.md"),
        ).exists(),
      ).toBe(false);
      expect(await readFile(path.join(campaign, STORY_BEATS_MD), "utf8")).toBe(
        "- old beat\n",
      );
      expect(loop.currentPlayState.success_turn_count).toBe(1);
      const seed = (await journals(campaign)).at(-1)!.seeds;
      expect(JSON.stringify(seed)).toContain("one");
      expect(JSON.stringify(seed)).not.toContain("two");

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("strike after old transcript-only deletes only undoes the last visible turn", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: (c) => c.say(`reply ${c.prompt}`),
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      expect((await loop.turn("one")).outcome).toBe("success");
      expect((await loop.turn("two")).outcome).toBe("success");
      expect((await loop.turn("three")).outcome).toBe("success");
      expect((await loop.turn("four")).outcome).toBe("success");
      expect((await loop.turn("five")).outcome).toBe("success");
      const afterFive = await readTranscript(campaign);
      expect(afterFive.filter((r) => r.role === "gm")).toHaveLength(5);

      await deleteLastTranscript(campaign);
      await deleteLastTranscript(campaign);
      await commitCampaign(campaign, "delete");
      const chopped = await readTranscript(campaign);
      expect(chopped.filter((r) => r.role === "gm")).toHaveLength(3);
      expect(chopped.some((r) => r.text === "reply five")).toBe(false);
      expect(chopped.some((r) => r.text === "reply three")).toBe(true);

      await loop.deleteTranscript();

      const after = await readTranscript(campaign);
      expect(after.filter((r) => r.role === "gm").map((r) => r.text)).toEqual([
        "reply one",
        "reply two",
      ]);
      expect(after.some((r) => r.text === "reply three")).toBe(false);
      expect((await listCampaignHistory(campaign)).some((c) => c.message === "turn 2")).toBe(
        true,
      );
      expect((await listCampaignHistory(campaign)).some((c) => c.message === "turn 1")).toBe(
        true,
      );

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("FAIL-path last player-only delete leaves the prior GM row", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      // the second Turn's model stays silent, even through OMP's nudges
      const gm = await scriptedGameMaster({ steps: [says("She nods.")], fallback: () => {} });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      expect((await loop.turn("I nod")).outcome).toBe("success");
      expect((await loop.turn("empty please")).outcome).toBe("fail");
      expect(
        (await listCampaignHistory(campaign)).some((c) => c.message === "fail"),
      ).toBe(true);

      const before = await readTranscript(campaign);
      expect(before.map((r) => r.role)).toEqual(["player", "gm", "player"]);
      expect(await readScratch(campaign)).toHaveLength(1);

      const deleted = await loop.deleteTranscript();
      expect(deleted).toHaveLength(1);
      expect(deleted[0]?.role).toBe("player");
      expect(deleted[0]?.text).toBe("empty please");
      expect((await readTranscript(campaign)).map((r) => r.role)).toEqual([
        "player",
        "gm",
      ]);
      expect(await readScratch(campaign)).toHaveLength(1);
      expect(
        (await listCampaignHistory(campaign)).some((c) => c.message === "fail"),
      ).toBe(false);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("cancel mid-turn then strike rewinds live writes", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        dossiers: {
          "pell-door":
            "---\nname: Pell\naliases: []\nkind: person\n---\nBefore.\n",
        },
      });
      const pellPath = path.join(campaign, "dossiers", "pell-door.md");
      const beforePell = await readFile(pellPath, "utf8");
      const entered = Promise.withResolvers<void>();
      // the model is still thinking (nothing said yet) when Stop lands
      const gm = await scriptedGameMaster({
        steps: [
          async (c) => {
            c.think("Pell hesitates.");
            entered.resolve();
            await c.aborted();
          },
        ],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();

      const turnPromise = loop.turn("open the door");
      await entered.promise;
      // meanwhile the Campaign changes on disk mid-Turn (the player's editor)
      await Bun.write(
        pellPath,
        "---\nname: Pell\naliases: []\nkind: person\n---\nHalfway rewrite.\n",
      );
      loop.interrupt();
      const failed = await turnPromise;
      expect(failed.outcome).toBe("fail");
      expect(failed.reason).toBe("interrupt");
      expect(await readFile(pellPath, "utf8")).toContain("Halfway rewrite");
      expect((await listCampaignHistory(campaign))[0]?.message).toBe("fail");

      const deleted = await loop.deleteTranscript();
      expect(deleted.map((r) => r.role)).toEqual(["player"]);
      expect(deleted[0]?.text).toBe("open the door");
      expect(await readFile(pellPath, "utf8")).toBe(beforePell);
      expect(await readTranscript(campaign)).toEqual([]);
      expect(
        (await listCampaignHistory(campaign)).some((c) => c.message === "fail"),
      ).toBe(false);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("strike fail then play then strike only undoes the new turn", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      // the "cancelled" Turn's model stays silent, even through OMP's nudges
      let silent = false;
      const gm = await scriptedGameMaster({
        steps: [says("First light.")],
        fallback: (c) => {
          if (!silent) c.say("Second light.");
        },
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      expect((await loop.turn("one")).outcome).toBe("success");
      silent = true;
      expect((await loop.turn("cancelled")).outcome).toBe("fail");
      silent = false;
      await loop.deleteTranscript();
      expect((await loop.turn("two")).outcome).toBe("success");

      const afterTwo = await readTranscript(campaign);
      expect(afterTwo.filter((r) => r.role === "gm").map((r) => r.text)).toEqual([
        "First light.",
        "Second light.",
      ]);
      await loop.deleteTranscript();
      expect(
        (await readTranscript(campaign)).filter((r) => r.role === "gm").map((r) => r.text),
      ).toEqual(["First light."]);
      expect(loop.currentPlayState.success_turn_count).toBe(1);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("player-only strike without a fail commit still chops", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: says("She nods.") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      expect((await loop.turn("I nod")).outcome).toBe("success");
      await appendTranscriptRow(campaign, {
        role: "player",
        text: "legacy dirty tail",
        ts: "2026-08-18T04:46:00.072Z",
      });

      const deleted = await loop.deleteTranscript();
      expect(deleted.map((r) => r.role)).toEqual(["player"]);
      expect(deleted[0]?.text).toBe("legacy dirty tail");
      expect((await readTranscript(campaign)).map((r) => r.role)).toEqual([
        "player",
        "gm",
      ]);
      expect((await listCampaignHistory(campaign))[0]?.message).toBe("turn 1");
      expect(
        (await listCampaignHistory(campaign)).some((c) => c.message === "fail"),
      ).toBe(false);
      expect(loop.currentPlayState.success_turn_count).toBe(1);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("mid-log delete is refused and does not commit", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: says("Echo.") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("one");
      await loop.turn("two");
      const rows = await readTranscript(campaign);
      const session = loop.currentSession;
      const journalsBefore = await journals(campaign);
      const before = await listCampaignHistory(campaign);

      let err: unknown;
      try {
        await loop.deleteTranscript(rows[0]!.ts);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("not_last");
      expect(await readTranscript(campaign)).toEqual(rows);
      expect(await listCampaignHistory(campaign)).toEqual(before);
      expect(loop.currentSession).toBe(session);
      expect(await journals(campaign)).toEqual(journalsBefore);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("edit and delete refuse while Turning", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const entered = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        steps: [
          async (c) => {
            entered.resolve();
            await c.aborted();
          },
        ],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const turn = loop.turn("hold");
      await entered.promise;

      let editErr: unknown;
      try {
        await loop.editTranscript("nope", "x");
      } catch (e) {
        editErr = e;
      }
      expect(editErr).toBeInstanceOf(CampaignError);
      expect((editErr as CampaignError).code).toBe("busy");

      let deleteErr: unknown;
      try {
        await loop.deleteTranscript();
      } catch (e) {
        deleteErr = e;
      }
      expect(deleteErr).toBeInstanceOf(CampaignError);
      expect((deleteErr as CampaignError).code).toBe("busy");

      loop.interrupt();
      await turn;
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("edit seeds the full transcript when it fits", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const early = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "CANARY-EARLY-OPENING that a bounded Turn tail would drop.",
        ts: "2026-01-01T00:00:00.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "player",
        text: "I wait.",
        ts: "2026-01-01T00:00:01.000Z",
      });
      const last = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "Later fog.",
        ts: "2026-01-01T00:00:02.000Z",
      });
      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.editTranscript(last.ts, "Later fog, edited.");
      const seeds = (await journals(campaign)).at(-1)!.seeds;
      expect(seeds).toEqual([
        { role: "assistant", content: early.text },
        { role: "user", content: "I wait." },
        { role: "assistant", content: "Later fog, edited." },
        { role: "developer", content: buildHistoryHandoff("full") },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("full replacement falls back to compact when only the handoff fits", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const row = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "Opening fog.",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { completionReserveTokens: 0 },
      });
      await loop.open();
      // the real estimator: the ceiling holds the pins plus the compact
      // handoff, and half of it (the seed budget) is below the pins alone
      const pins = await pinTokens(campaign);
      await loop.applyLiveSettings({
        compactCeilingTokens: pins + estimateTokensDefault(buildHistoryHandoff("compact")),
      });

      await loop.editTranscript(row.ts, "Opening fog, edited.");

      // the rebuilt session carries only the compact handoff, no transcript
      expect((await loop.turn("I wait.")).outcome).toBe("success");
      expect(history(gm.calls.at(-1)!)).toEqual([
        { role: "developer", content: buildHistoryHandoff("compact") },
        { role: "user", content: "I wait." },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("compact replacement rejects when the handoff cannot fit beside the prime, and the loop recovers", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const row = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "Opening fog.",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const gm = await scriptedGameMaster({ fallback: says("The fog lifts.") });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { completionReserveTokens: 0 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const first = loop.currentSession;
      const pins = await pinTokens(campaign);
      const handoff = estimateTokensDefault(buildHistoryHandoff("compact"));
      // the pins fit; the pins plus the handoff are one token over
      await loop.applyLiveSettings({ compactCeilingTokens: pins + handoff - 1 });

      let error: unknown;
      try {
        await loop.editTranscript(row.ts, "Opening fog, edited.");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(PinOverflowError);
      expect((error as PinOverflowError).estimated).toBe(pins + handoff);
      expect((error as PinOverflowError).budget).toBe(pins + handoff - 1);
      // the edit itself was committed before the replacement failed
      expect((await readTranscript(campaign))[0]?.text).toBe("Opening fog, edited.");
      expect((await listCampaignHistory(campaign))[0]?.message).toBe("edit");
      expect(
        events.some(
          (e) => e.type === "error" && e.message.startsWith("Session replace failed"),
        ),
      ).toBe(true);
      // a bare primed session replaced the ended one: live, unseeded, not busy
      expect(loop.loopState).toBe("idle");
      expect(loop.currentSession).not.toBeNull();
      expect(loop.currentSession).not.toBe(first);
      expect((await loop.turn("I wait.")).outcome).toBe("success");
      expect(history(gm.calls.at(-1)!)).toEqual([
        { role: "user", content: "I wait." },
      ]);

      // raising the ceiling from the book lets the next edit rebuild fully
      await loop.applyLiveSettings({ compactCeilingTokens: 128_000 });
      const again = await loop.editTranscript(row.ts, "Opening fog, edited twice.");
      expect(again.text).toBe("Opening fog, edited twice.");
      const js = await journals(campaign);
      expect(js[0]!.exited).toBe(true);
      expect(js.at(-1)!.seeds).toEqual([
        { role: "assistant", content: "Opening fog, edited twice." },
        { role: "user", content: "I wait." },
        { role: "assistant", content: "The fog lifts." },
        { role: "developer", content: buildHistoryHandoff("full") },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("turn and a second edit refuse while an edit is replacing the session", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const row = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "opening",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const session = loop.currentSession;
      // the edit claims the loop before its first await, and holds it through
      // the commit and the session rebuild
      const edit = loop.editTranscript(row.ts, "opening, edited");
      expect(loop.loopState).toBe("authoring");

      const turn = await loop.turn("overlap");
      expect(turn.outcome).toBe("fail");
      expect(turn.reason).toBe("busy");

      let second: unknown;
      try {
        await loop.editTranscript(row.ts, "again");
      } catch (e) {
        second = e;
      }
      expect(second).toBeInstanceOf(CampaignError);
      expect((second as CampaignError).code).toBe("busy");

      expect((await edit).text).toBe("opening, edited");
      expect(loop.loopState).toBe("idle");
      expect(loop.currentSession).not.toBe(session);
      // the refused Turn never reached the model or the transcript
      expect(gm.calls).toHaveLength(0);
      expect((await readTranscript(campaign)).map((r) => r.text)).toEqual([
        "opening, edited",
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("edit and delete refuse while hygiene is running", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        steps: [
          async (c) => {
            expect(isHygiene(c)).toBe(true);
            entered.resolve();
            await release.promise;
            c.say("hygiene");
          },
        ],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const hygiene = loop.runHygienePass("light");
      await entered.promise;

      let editErr: unknown;
      try {
        await loop.editTranscript("x", "y");
      } catch (e) {
        editErr = e;
      }
      expect((editErr as CampaignError).code).toBe("busy");

      let deleteErr: unknown;
      try {
        await loop.deleteTranscript();
      } catch (e) {
        deleteErr = e;
      }
      expect((deleteErr as CampaignError).code).toBe("busy");

      release.resolve();
      expect(await hygiene).toBe(true);
      expect(loop.loopState).toBe("idle");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("edit leaves scratch bytes unchanged; delete last GM prunes its record", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const opening = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "opening",
        ts: "2026-01-01T00:00:00.000Z",
      });
      await appendScratchRecord(campaign, {
        ts: opening.ts,
        turn: 0,
        thinking: "audit",
        tools: [],
      });
      const scratchBefore = await readFile(
        path.join(campaign, SCRATCH_JSONL),
        "utf8",
      );
      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.editTranscript(opening.ts, "opening, edited");
      expect(await readFile(path.join(campaign, SCRATCH_JSONL), "utf8")).toBe(
        scratchBefore,
      );

      await loop.deleteTranscript(opening.ts);
      expect(await readScratch(campaign)).toEqual([]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("PlaySession snapshot and events pick up the edited story plus ts", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const opening = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "Mira watches.",
        ts: "2026-01-01T00:00:00.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "player",
        text: "I nod.",
        ts: "2026-01-01T00:00:01.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "She snorts.",
        ts: "2026-01-01T00:00:02.000Z",
      });
      const layer = playSessionLayer({
        path: campaign,
        factory: (await scriptedGameMaster()).factory,
      });
      const prog = withPlaySession((s) =>
        Effect.gen(function* () {
          const before = yield* s.snapshot;
          expect(before.story.map((b) => b.ts)).toEqual([
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:01.000Z",
            "2026-01-01T00:00:02.000Z",
          ]);
          yield* s.editTranscript(opening.ts, "Mira watches the door.");
          const afterEdit = yield* s.snapshot;
          expect(afterEdit.story[0]).toEqual({
            role: "gm",
            text: "Mira watches the door.",
            ts: opening.ts,
            turn: 0,
          });
          expect(afterEdit.story).toHaveLength(3);
          yield* s.deleteTranscript();
          const afterDelete = yield* s.snapshot;
          expect(afterDelete.story).toHaveLength(1);
          expect(afterDelete.story[0]?.text).toBe("Mira watches the door.");
          return afterDelete;
        }),
      ).pipe(Effect.provide(layer), Effect.scoped);
      await Effect.runPromise(prog);
    } finally {
      await rmTempDir(root);
    }
  });

  test("story_replaced uses the serve transcript tail, not the full log", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      for (let i = 0; i < 5; i++) {
        await appendTranscriptRow(campaign, {
          role: i % 2 === 0 ? "gm" : "player",
          text: `row-${i}`,
          ts: `2026-01-01T00:00:0${i}.000Z`,
        });
      }
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: (await scriptedGameMaster()).factory,
        config: { playTranscriptTailRows: 2 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      await loop.editTranscript("2026-01-01T00:00:04.000Z", "row-4-edited");
      const replaced = events.filter((e) => e.type === "story_replaced").at(-1);
      expect(replaced?.type).toBe("story_replaced");
      if (replaced?.type === "story_replaced") {
        expect(replaced.story.map((b) => b.text)).toEqual([
          "row-3",
          "row-4-edited",
        ]);
        expect(replaced.story.every((b) => typeof b.ts === "string")).toBe(true);
      }
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("snapshotStory stamps listGmTurns numbers even when play_state drifted", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      for (let i = 0; i < 5; i++) {
        await appendTranscriptRow(campaign, {
          role: i % 2 === 0 ? "gm" : "player",
          text: `row-${i}`,
          ts: `2026-01-01T00:00:0${i}.000Z`,
        });
      }
      await savePlayState(campaign, {
        success_turn_count: 99,
        luck_points: 5,
        luck_armed: false,
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: (await scriptedGameMaster()).factory,
        config: { playTranscriptTailRows: 2 },
      });
      await loop.open();
      const story = await loop.snapshotStory();
      expect(story.map((b) => ({ role: b.role, turn: b.turn }))).toEqual([
        { role: "player", turn: undefined },
        { role: "gm", turn: 2 },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("edit unknown ts does not commit", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("hi");
      const before = await listCampaignHistory(campaign);
      const session = loop.currentSession;
      const journalsBefore = await journals(campaign);

      let err: unknown;
      try {
        await loop.editTranscript("missing-ts", "nope");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("not_found");
      expect(await listCampaignHistory(campaign)).toEqual(before);
      expect(loop.currentSession).toBe(session);
      expect(await journals(campaign)).toEqual(journalsBefore);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
