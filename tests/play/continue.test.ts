import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CampaignError,
  findTurnCommit,
  listCampaignHistory,
  PLAYER_SHEET_MD,
  readScratch,
  readTranscript,
} from "../../src/campaign/index.ts";
import {
  buildHistoryHandoff,
  CONTINUE_INSTRUCTION_MARK,
  PlayLoop,
  type AgentSession,
  type PlayEvent,
} from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import {
  scriptedGameMaster,
  says,
  type ModelCall,
  type ScriptStep,
} from "../helpers/game_master.ts";

const SEED_WITH_OPENING = `# Voice

Speak sparsely.

## Opening message

And then he

## Memory

Keep files current.
`;

const SHEET_LATER = `## Description
Later ranger.

## Inventory
- later blade

## Powers

## Notes
`;

// ---- what the (scripted) model was sent -----------------------------------

type Line = { role: "user" | "assistant" | "system"; text: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("");
}

/** The dialogue the model saw, oldest first; developer handoffs read as system. */
function dialogue(call: ModelCall): Line[] {
  return call.context.messages.flatMap((m): Line[] => {
    const role = m.role as string;
    if (role === "user") return [{ role: "user", text: textOf(m.content) }];
    if (role === "assistant") {
      return [{ role: "assistant", text: textOf(m.content) }];
    }
    if (role === "developer") return [{ role: "system", text: textOf(m.content) }];
    return [];
  });
}

// hidden passes reach the model as a developer message: `instruction`
const isHygiene = (call: ModelCall) =>
  call.instruction.startsWith("[Memory Hygiene");
const isContinue = (call: ModelCall) =>
  call.prompt.startsWith(CONTINUE_INSTRUCTION_MARK);

/**
 * What a rebuilt session carries: play one more Turn and read the history the
 * model is sent, minus that Turn's own player line.
 */
async function seededHistory(
  loop: PlayLoop,
  gm: { calls: ModelCall[] },
): Promise<Line[]> {
  const before = gm.calls.length;
  expect((await loop.turn("(probe)")).outcome).toBe("success");
  const probe = gm.calls.slice(before).find((c) => c.prompt === "(probe)")!;
  const lines = dialogue(probe);
  expect(lines.at(-1)).toEqual({ role: "user", text: "(probe)" });
  return lines.slice(0, -1);
}

/** Replies by what the call is: hygiene, Continue, or a play Turn. */
function router(opts: {
  play: (call: ModelCall) => string;
  cont?: string;
  hygiene?: ScriptStep;
}): ScriptStep {
  return (call) => {
    if (isHygiene(call)) {
      return (opts.hygiene ?? says("hygiene"))(call);
    }
    if (isContinue(call)) return call.say(opts.cont ?? "And then he picked up the sword…");
    return call.say(opts.play(call));
  };
}

/** Continuations come back empty; any other call is an ordinary play reply. */
function emptyContinue(onContinue: () => void): ScriptStep {
  return (call) => {
    if (isContinue(call)) return onContinue();
    call.say("A later beat.");
  };
}

describe("Play Loop — Continue rewind + extend", () => {
  test("extend at HEAD keeps the last GM ts, changes text, and adds no player row", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [says("And then he"), says("picked up the sword…")],
        fallback: says("A later beat."),
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      expect((await loop.turn("I wait.")).outcome).toBe("success");
      const before = await readTranscript(campaign);
      expect(before.map((r) => r.role)).toEqual(["player", "gm"]);
      const last = before[1]!;
      expect(last.text).toBe("And then he");
      const session = loop.currentSession;
      const historyBefore = await listCampaignHistory(campaign);
      const countBefore = loop.currentPlayState.success_turn_count;

      const result = await loop.continueFromTurn(1);
      expect(result.outcome).toBe("success");
      expect(result.prose).toBe("And then he picked up the sword…");
      expect(result.playState.success_turn_count).toBe(countBefore);

      const after = await readTranscript(campaign);
      expect(after.map((r) => r.role)).toEqual(["player", "gm"]);
      expect(after[1]?.ts).toBe(last.ts);
      expect(after[1]?.text).toBe("And then he picked up the sword…");
      expect(after.some((r) => r.text === "(continue)")).toBe(false);

      // the model was asked to continue its own line, not sent the stub as a player line
      const cont = gm.calls[1]!;
      expect(cont.prompt.startsWith(CONTINUE_INSTRUCTION_MARK)).toBe(true);
      expect(cont.prompt).toContain("«And then he»");
      expect(dialogue(cont).slice(0, -1)).toEqual([
        { role: "user", text: "I wait." },
        { role: "assistant", text: "And then he" },
      ]);

      const history2 = await listCampaignHistory(campaign);
      expect(history2).toHaveLength(historyBefore.length + 1);
      expect(history2[0]?.message).toBe("continue 1");
      expect(loop.currentSession).not.toBe(session);
      expect(loop.hasPrimedSession).toBe(true);
      // the replacement session holds the finished line, then the handoff
      expect(await seededHistory(loop, gm)).toEqual([
        { role: "user", text: "I wait." },
        { role: "assistant", text: "And then he picked up the sword…" },
        { role: "system", text: buildHistoryHandoff("full") },
      ]);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("extend does not concatenate a model rewrite onto the stub", async () => {
    const stub = "The last is newer, nailed hard: *feral cat";
    const rewrite =
      "The last notice finishes in a harder hand than the others: *feral harpy — dusk raids on the north palisade — twelve silver for the body.* That’s the whole board from where you stand.";
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ steps: [says(stub), says(rewrite)] });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      expect((await loop.turn("I wait.")).outcome).toBe("success");

      const result = await loop.continueFromTurn(1);
      expect(result.outcome).toBe("success");
      // the restated beat is dropped; only what follows it is kept
      expect(result.prose).toBe(
        `${stub} That’s the whole board from where you stand.`,
      );

      const after = await readTranscript(campaign);
      expect(after).toHaveLength(2);
      expect(after[1]?.text).toBe(result.prose);
      expect(after.some((r) => r.text === "(continue)")).toBe(false);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("rewind drops later files, transcript, scratch, and unreachable commits", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const sheetAtBirth = await readFile(
        path.join(campaign, PLAYER_SHEET_MD),
        "utf8",
      );
      // Memory Hygiene after Turn 2 rewrites the Player Sheet with the real write tool
      const gm = await scriptedGameMaster({
        fallback: router({
          play: (c) => (c.prompt === "two" ? "Later fog. A second beat." : "And then he"),
          hygiene: (c) => {
            if (c.toolResults.some((r) => r.name === "write")) return c.say("hygiene");
            c.tool("write", { path: PLAYER_SHEET_MD, content: SHEET_LATER });
          },
        }),
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 2 },
      });
      await loop.open();
      expect((await loop.turn("one")).outcome).toBe("success");
      const afterOne = await readTranscript(campaign);
      const firstGm = afterOne.find((r) => r.role === "gm")!;
      expect((await loop.turn("two")).outcome).toBe("success");
      expect(await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8")).toBe(
        SHEET_LATER,
      );
      expect(await readTranscript(campaign)).toHaveLength(4);
      expect(await readScratch(campaign)).toHaveLength(2);
      const historyBefore = await listCampaignHistory(campaign);
      expect(historyBefore.some((c) => c.message === "turn 2")).toBe(true);

      const result = await loop.continueFromTurn(1);
      expect(result.outcome).toBe("success");
      expect(loop.currentPlayState.success_turn_count).toBe(1);

      const after = await readTranscript(campaign);
      expect(after).toHaveLength(2);
      expect(after.map((r) => r.role)).toEqual(["player", "gm"]);
      expect(after[1]?.ts).toBe(firstGm.ts);
      expect(after[1]?.text).toBe("And then he picked up the sword…");
      expect(after.some((r) => r.text === "two")).toBe(false);
      expect(after.some((r) => r.text === "(continue)")).toBe(false);

      expect(await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8")).toBe(
        sheetAtBirth,
      );
      const scratch = await readScratch(campaign);
      expect(scratch).toHaveLength(1);
      expect(scratch[0]?.ts).toBe(firstGm.ts);
      expect(scratch[0]?.turn).toBe(1);

      const history = await listCampaignHistory(campaign);
      expect(history.some((c) => c.message === "turn 2")).toBe(false);
      expect(history[0]?.message).toBe("continue 1");
      expect(await findTurnCommit(campaign, 1)).toBe(history[0]!.oid);
      expect(await findTurnCommit(campaign, 2)).toBeNull();

      // the Continue itself ran on the rewound story, without Turn 2
      const cont = gm.calls.find(isContinue)!;
      expect(dialogue(cont).some((l) => l.text === "two")).toBe(false);
      expect(dialogue(cont).some((l) => l.text.includes("Later fog"))).toBe(false);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("opening is turn 0", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { seed: SEED_WITH_OPENING });
      const gm = await scriptedGameMaster({
        steps: [says("First reply after the opening."), says("picked up the sword…")],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const opening = (await readTranscript(campaign))[0]!;
      expect(opening.role).toBe("gm");
      expect(opening.text).toBe("And then he");
      expect((await loop.turn("I wait.")).outcome).toBe("success");
      expect(await readTranscript(campaign)).toHaveLength(3);
      expect(loop.currentPlayState.success_turn_count).toBe(1);

      const result = await loop.continueFromTurn(0);
      expect(result.outcome).toBe("success");
      expect(result.prose).toBe("And then he picked up the sword…");

      const after = await readTranscript(campaign);
      expect(after).toHaveLength(1);
      expect(after[0]?.ts).toBe(opening.ts);
      expect(after[0]?.role).toBe("gm");
      expect(after[0]?.text).toBe("And then he picked up the sword…");
      expect(after.some((r) => r.text === "(continue)")).toBe(false);
      expect(loop.currentPlayState.success_turn_count).toBe(0);

      const history = await listCampaignHistory(campaign);
      expect(history[0]?.message).toBe("continue 0");
      expect(history.some((c) => c.message === "turn 1")).toBe(false);
      expect(await findTurnCommit(campaign, 0)).toBe(history[0]!.oid);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("Continue refuses while Turning and does not start a second rewind", async () => {
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
      const history = await listCampaignHistory(campaign);

      const err = await loop.continueFromTurn(1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("busy");
      expect(await listCampaignHistory(campaign)).toEqual(history);

      loop.interrupt();
      expect((await turn).reason).toBe("interrupt");
      expect(gm.calls.some(isContinue)).toBe(false);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("Continue refuses while an edit is in flight", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: says("And then he") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("I wait.");
      const row = (await readTranscript(campaign)).find((r) => r.role === "gm")!;

      // the edit rewrites the row, commits, then replaces the session
      const edit = loop.editTranscript(row.ts, "And then he, edited");
      expect(loop.loopState).toBe("authoring");
      const err = await loop.continueFromTurn(1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("busy");

      await edit;
      expect(loop.loopState).toBe("idle");
      expect(gm.calls.some(isContinue)).toBe(false);
      const rows = await readTranscript(campaign);
      expect(rows[1]?.text).toBe("And then he, edited");
      expect((await listCampaignHistory(campaign))[0]?.message).toBe("edit");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("unknown turn and turn 0 without an opening are not_found", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: says("Echo.") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("one");
      const before = await readTranscript(campaign);
      const history = await listCampaignHistory(campaign);

      const missing = await loop.continueFromTurn(9).catch((e: unknown) => e);
      expect((missing as CampaignError).code).toBe("not_found");
      expect(loop.loopState).toBe("idle");

      const opening = await loop.continueFromTurn(0).catch((e: unknown) => e);
      expect((opening as CampaignError).code).toBe("not_found");
      expect(loop.loopState).toBe("idle");
      expect(await readTranscript(campaign)).toEqual(before);
      expect(await listCampaignHistory(campaign)).toEqual(history);
      expect(gm.calls).toHaveLength(1);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("FAIL extend keeps the stub, does not commit continue, and leaves rewind in place", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      let prompted: AgentSession | null = null;
      const gm = await scriptedGameMaster({
        steps: [says("And then he"), says("Later fog.")],
        // every continuation comes back empty (OMP asks again; still empty)
        fallback: emptyContinue(() => {
          prompted = loop.currentSession;
        }),
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("one");
      const firstGm = (await readTranscript(campaign)).find((r) => r.role === "gm")!;
      await loop.turn("two");
      const historyBefore = await listCampaignHistory(campaign);

      const result = await loop.continueFromTurn(1);
      expect(result.outcome).toBe("fail");
      expect(result.reason).toBe("empty_prose");

      const after = await readTranscript(campaign);
      expect(after).toHaveLength(2);
      expect(after[1]?.ts).toBe(firstGm.ts);
      expect(after[1]?.text).toBe("And then he");
      const history = await listCampaignHistory(campaign);
      expect(history.some((c) => c.message.startsWith("continue"))).toBe(false);
      expect(history.some((c) => c.message === "turn 2")).toBe(false);
      expect(history.length).toBeLessThan(historyBefore.length);

      // the session that saw the Continue instruction is gone; the rebuild
      // holds the stub as the Game Master's line, never as a player prompt
      expect(prompted).not.toBeNull();
      expect(loop.currentSession).not.toBe(prompted);
      const seeds = await seededHistory(loop, gm);
      expect(seeds.filter((l) => l.role === "user" && l.text === "And then he")).toHaveLength(0);
      expect(seeds.some((l) => l.role === "assistant" && l.text === "And then he")).toBe(true);
      expect(seeds.some((l) => l.text.startsWith(CONTINUE_INSTRUCTION_MARK))).toBe(false);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("empty Enter after Continue is still a player (continue) row", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [says("And then he"), says("picked up the sword…"), says("A new beat.")],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("I wait.");
      await loop.continueFromTurn(1);
      expect((await loop.turn("  ")).outcome).toBe("success");
      const rows = await readTranscript(campaign);
      expect(rows.map((r) => r.role)).toEqual(["player", "gm", "player", "gm"]);
      expect(rows[2]?.text).toBe("(continue)");
      expect(rows[3]?.text).toBe("A new beat.");
      expect(gm.calls[2]?.prompt).toBe("(continue)");

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("Continue after Edit persists an uppercase continuation and reseeds the session", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const editedPrefix =
        "The room quiets as she steps close. She smiles playfully";
      const continuation =
        "She does not give you room to turn around. Her hand closes over the latch behind you.";
      const continued = `${editedPrefix}\n\n${continuation}`;
      const gm = await scriptedGameMaster({
        steps: [says("The room quiets as she steps close."), says(continuation)],
        fallback: says("A later beat."),
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("I wait.");
      const row = (await readTranscript(campaign)).find((r) => r.role === "gm")!;
      await loop.editTranscript(row.ts, editedPrefix);
      const before = await readTranscript(campaign);
      const session = loop.currentSession;
      const successCount = loop.currentPlayState.success_turn_count;

      const result = await loop.continueFromTurn(1);

      expect(result.outcome).toBe("success");
      expect(result.prose).toBe(continued);
      // the Continue saw the edited line, not the model's original
      expect(dialogue(gm.calls[1]!)).toContainEqual({
        role: "assistant",
        text: editedPrefix,
      });
      const after = await readTranscript(campaign);
      expect(after).toHaveLength(before.length);
      expect(after.map((r) => r.role)).toEqual(before.map((r) => r.role));
      expect(after[1]?.ts).toBe(row.ts);
      expect(after[1]?.text).toBe(continued);
      expect(after.some((r) => r.text === "(continue)")).toBe(false);
      expect(result.playState.success_turn_count).toBe(successCount);
      expect((await listCampaignHistory(campaign))[1]?.message).toBe("edit");
      expect(loop.currentSession).not.toBe(session);
      expect(loop.hasPrimedSession).toBe(true);
      expect(await seededHistory(loop, gm)).toContainEqual({
        role: "assistant",
        text: continued,
      });

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("two overlapping Continues from Idle cannot both proceed", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [says("And then he"), says("picked up the sword…")],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("I wait.");

      const settled = await Promise.allSettled([
        loop.continueFromTurn(1),
        loop.continueFromTurn(1),
      ]);
      const rejected = settled.filter((r) => r.status === "rejected");
      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      expect(rejected).toHaveLength(1);
      const reason = (rejected[0] as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(CampaignError);
      expect((reason as CampaignError).code).toBe("busy");
      expect(fulfilled).toHaveLength(1);
      if (fulfilled[0]?.status === "fulfilled") {
        expect(fulfilled[0].value.outcome).toBe("success");
      }
      expect(loop.loopState).toBe("idle");
      expect(gm.calls.filter(isContinue)).toHaveLength(1);
      const rows = await readTranscript(campaign);
      expect(rows.filter((r) => r.role === "gm")).toHaveLength(1);
      expect(rows[1]?.text).toBe("And then he picked up the sword…");

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("turn and a second Continue refuse while a Continue is in flight", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const inContinue = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        steps: [
          says("And then he"),
          async (c) => {
            c.say("picked up");
            inContinue.resolve();
            await release.promise;
            c.say(" the sword…");
          },
        ],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("I wait.");
      const cont = loop.continueFromTurn(1);
      await inContinue.promise;
      expect(loop.loopState).toBe("turning");

      const overlap = await loop.turn("overlap");
      expect(overlap.outcome).toBe("fail");
      expect(overlap.reason).toBe("busy");

      const second = await loop.continueFromTurn(1).catch((e: unknown) => e);
      expect((second as CampaignError).code).toBe("busy");

      release.resolve();
      const result = await cont;
      expect(result.outcome).toBe("success");
      expect(result.prose).toBe("And then he picked up the sword…");
      expect(loop.loopState).toBe("idle");
      const rows = await readTranscript(campaign);
      expect(rows.some((r) => r.text === "overlap")).toBe(false);
      expect(gm.calls).toHaveLength(2);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("Continue seeds the full rewound transcript when it fits", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { seed: SEED_WITH_OPENING });
      const gm = await scriptedGameMaster({
        fallback: router({ play: (c) => `Beat for ${c.prompt}` }),
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("one");
      await loop.turn("two");
      await loop.continueFromTurn(0);
      expect(await seededHistory(loop, gm)).toEqual([
        { role: "assistant", text: "And then he picked up the sword…" },
        { role: "system", text: buildHistoryHandoff("full") },
      ]);
      // the handoff defers prose style to the current system voice
      expect(buildHistoryHandoff("full")).toContain(
        "historical player and Game Master dialogue is above",
      );
      expect(
        buildHistoryHandoff("full").endsWith(
          "Continue as Game Master using the current system voice, not the style of the historical dialogue. Reply only with finished story prose.",
        ),
      ).toBe(true);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("story_replaced after rewind then extend uses the same GM ts", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      const gm = await scriptedGameMaster({
        steps: [says("And then he"), says("Later fog."), says("picked up the sword…")],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      await loop.turn("one");
      const firstGm = (await readTranscript(campaign)).find((r) => r.role === "gm")!;
      await loop.turn("two");
      await loop.continueFromTurn(1);

      const started = events.filter((e) => e.type === "turn_started");
      expect(started.at(-1)).toMatchObject({
        extend: true,
        playerText: "And then he",
        ts: firstGm.ts,
      });
      const ended = events.filter((e) => e.type === "turn_ended");
      expect(ended.at(-1)).toMatchObject({
        extend: true,
        outcome: "success",
        prose: "And then he picked up the sword…",
        ts: firstGm.ts,
      });
      const replaced = events.filter((e) => e.type === "story_replaced");
      expect(replaced.length).toBeGreaterThanOrEqual(2);
      const rewindStory = replaced.find(
        (e) =>
          e.type === "story_replaced" &&
          e.busy === true &&
          e.story.at(-1)?.text === "And then he",
      );
      expect(rewindStory).toBeDefined();
      const last = replaced.at(-1);
      expect(last?.type).toBe("story_replaced");
      if (last?.type === "story_replaced") {
        expect(last.story.at(-1)).toEqual({
          role: "gm",
          text: "And then he picked up the sword…",
          ts: firstGm.ts,
          turn: 1,
        });
        expect(last.story.some((b) => b.text === "(continue)")).toBe(false);
        expect(last.successTurnCount).toBe(1);
      }

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("Continue FAIL at HEAD replaces the session so the stub is not a user prompt", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      let prompted: AgentSession | null = null;
      const gm = await scriptedGameMaster({
        steps: [says("And then he")],
        fallback: emptyContinue(() => {
          prompted = loop.currentSession;
        }),
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("I wait.");
      expect((await loop.continueFromTurn(1)).outcome).toBe("fail");
      expect(prompted).not.toBeNull();
      expect(loop.currentSession).not.toBe(prompted);
      const seeds = await seededHistory(loop, gm);
      expect(seeds.filter((l) => l.role === "user" && l.text === "And then he")).toHaveLength(0);
      expect(seeds).toEqual([
        { role: "user", text: "I wait." },
        { role: "assistant", text: "And then he" },
        { role: "system", text: buildHistoryHandoff("full") },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("Continue SUCCESS that compact-rebuilds keeps the compact session", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: (c) => {
          if (isHygiene(c)) return c.say("heavy ok");
          if (isContinue(c)) {
            // the provider reports a prompt over the 128k rebuild ceiling
            c.usage({ input: 150_000 });
            return c.say("And then he picked up the sword…");
          }
          c.say("And then he");
        },
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { compactCeilingTokens: 128_000 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      await loop.turn("I wait.");
      expect(events.some((e) => e.type === "compact_started")).toBe(false);
      await loop.continueFromTurn(1);
      expect(events.some((e) => e.type === "compact_ended" && e.ok)).toBe(true);
      expect(
        gm.calls.some((c) => isHygiene(c) && c.instruction.includes("HEAVY MODE")),
      ).toBe(true);
      // the compact rebuild is kept, not overwritten by a full-history one
      const seeds = await seededHistory(loop, gm);
      expect(seeds.at(-1)).toEqual({
        role: "system",
        text: buildHistoryHandoff("compact"),
      });
      expect(seeds).toContainEqual({
        role: "assistant",
        text: "And then he picked up the sword…",
      });
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("Continue does not re-run Light hygiene already paid for this success count", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: router({ play: () => "And then he" }),
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 1 },
      });
      await loop.open();
      await loop.turn("I wait.");
      expect(gm.calls.filter(isHygiene)).toHaveLength(1);
      await loop.continueFromTurn(1);
      expect(gm.calls.some(isContinue)).toBe(true);
      expect(gm.calls.filter(isHygiene)).toHaveLength(1);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
