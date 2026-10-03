import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CampaignError,
  appendTranscriptRow,
  listCampaignHistory,
  loadPlayState,
  readTranscript,
} from "../../src/campaign/index.ts";
import {
  buildHistoryHandoff,
  HYGIENE_TOOL_NAMES,
  PLAY_TOOL_NAMES,
  PlayLoop,
  SESSION_TOOL_NAMES,
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

/** Over the 128k rebuild ceiling, under the model's 200k window. */
const OVER_CEILING = 150_000;

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

/**
 * The Memory Hygiene brief this call is working on, if it is a hygiene call.
 * Hidden passes reach the model as a developer message: `instruction`.
 */
function hygieneBrief(call: ModelCall): string | undefined {
  return call.instruction.startsWith("[Memory Hygiene") ? call.instruction : undefined;
}

const isHygiene = (call: ModelCall) => hygieneBrief(call) !== undefined;

/** First model call of each hygiene pass (later calls carry tool results). */
function hygienePasses(calls: ModelCall[]): Array<"light" | "heavy"> {
  return calls
    .filter((c) => isHygiene(c) && c.toolResults.length === 0)
    .map((c) => (hygieneBrief(c)!.includes("HEAVY MODE") ? "heavy" : "light"));
}

function offeredTools(call: ModelCall): string[] {
  return (call.context.tools ?? []).map((t) => t.name);
}

/** A hygiene pass that writes `files` with the real `write` tool, then signs off. */
function hygieneWrites(files: Record<string, string>, summary = "hygiene ok"): ScriptStep {
  return (call) => {
    if (call.toolResults.length > 0) return call.say(summary);
    for (const [file, content] of Object.entries(files)) {
      call.tool("write", { path: file, content });
    }
  };
}

/** Replies by what the call is: a hygiene pass or a play Turn. */
function router(opts: {
  play?: ScriptStep;
  hygiene?: ScriptStep;
}): ScriptStep {
  return (call) =>
    isHygiene(call)
      ? (opts.hygiene ?? says("hygiene ok"))(call)
      : (opts.play ?? ((c: ModelCall) => c.say(`Beat for: ${c.prompt}`)))(call);
}

/** A play reply that reports a prompt over the rebuild ceiling. */
function overCeiling(text: (call: ModelCall) => string): ScriptStep {
  return (call) => {
    call.usage({ input: OVER_CEILING });
    call.say(text(call));
  };
}

/**
 * What the current session carries: play one more Turn and read the history
 * the model is sent, minus that Turn's own player line.
 */
async function seededHistory(
  loop: PlayLoop,
  gm: { calls: ModelCall[] },
): Promise<{ lines: Line[]; call: ModelCall }> {
  const before = gm.calls.length;
  expect((await loop.turn("(probe)")).outcome).toBe("success");
  const call = gm.calls.slice(before).find((c) => c.prompt === "(probe)")!;
  const lines = dialogue(call);
  expect(lines.at(-1)).toEqual({ role: "user", text: "(probe)" });
  return { lines: lines.slice(0, -1), call };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
}

describe("Memory Hygiene + rebuild-compaction", () => {
  test("every pass offers the same tools; each pass may call only its own", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const beatsBefore = await readFile(path.join(campaign, "story-beats.md"), "utf8");
      const gm = await scriptedGameMaster({
        fallback: router({
          // play reaches for a memory writer, then answers
          play: (c) =>
            c.toolResults.length === 0 && c.prompt === "I wait."
              ? c.tool("edit", {
                  path: "story-beats.md",
                  edits: [{ oldText: "", newText: "- sneaked in\n" }],
                })
              : c.say(`Beat for: ${c.prompt}`),
          // hygiene reaches for the dice, then writes memory for real
          hygiene: (c) => {
            if (c.toolResults.length === 0) return c.tool("roll", { n: 6 });
            if (c.toolResults.length === 1) {
              return c.tool("write", { path: "story-beats.md", content: "- hygiene beat\n" });
            }
            return c.say("hygiene ok");
          },
        }),
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 1 },
      });
      await loop.open();

      expect((await loop.turn("I wait.")).outcome).toBe("success");
      expect((await loop.turn("I wait again.")).outcome).toBe("success");
      await loop.close();

      // one tool list for the whole session, so the engine's prompt cache
      // survives a hygiene pass and the Turn after it
      for (const call of gm.calls) {
        expect(offeredTools(call).sort()).toEqual([...SESSION_TOOL_NAMES].sort());
      }
      expect(gm.calls.some(isHygiene)).toBe(true);

      // play may not write memory
      const refusedEdit = gm.calls
        .flatMap((c) => c.toolResults)
        .find((r) => r.name === "edit");
      expect(refusedEdit?.text).toBe(
        `edit is not available now. Use only: ${PLAY_TOOL_NAMES.join(", ")}.`,
      );
      // hygiene may not roll, but its own tools work
      const refusedRoll = gm.calls
        .filter(isHygiene)
        .flatMap((c) => c.toolResults)
        .find((r) => r.name === "roll");
      expect(refusedRoll?.text).toBe(
        `roll is not available now. Use only: ${HYGIENE_TOOL_NAMES.join(", ")}.`,
      );
      const beats = await readFile(path.join(campaign, "story-beats.md"), "utf8");
      expect(beats).not.toContain("sneaked in");
      expect(beats).not.toBe(beatsBefore);
      expect(beats).toContain("- hygiene beat");
    } finally {
      await rmTempDir(root);
    }
  });

  test("light hygiene every N successes: hidden prompt, cursors, no gm row", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      const gm = await scriptedGameMaster({
        fallback: router({
          play: (c) => c.say(`Echo: ${c.prompt}`),
          hygiene: (c) => {
            const done = c.toolResults;
            if (done.length === 0) {
              c.think("Checking durable memory.\n");
              c.tool("read", { path: "story-beats.md" });
            } else if (done.length === 1) {
              c.tool("write", { path: "story-beats.md", content: "- ranger entered marsh\n" });
              c.tool("write", { path: "quest-log.md", content: "- find the bell\n" });
            } else {
              c.say("hygiene internal summary — discard me");
            }
          },
        }),
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 2 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      await loop.turn("one");
      expect(events.some((e) => e.type === "hygiene_started")).toBe(false);
      expect(gm.calls.some(isHygiene)).toBe(false);
      await loop.turn("two");
      expect(
        events.some((e) => e.type === "hygiene_started" && e.mode === "light"),
      ).toBe(true);
      expect(
        events.some((e) => e.type === "status" && e.message.includes("hygiene")),
      ).toBe(true);
      const liveScratch = events.findLast((event) => event.type === "scratch_live");
      expect(liveScratch).toMatchObject({
        type: "scratch_live",
        thinking: "Checking durable memory.\n",
      });
      if (liveScratch?.type === "scratch_live") {
        expect(liveScratch.tools.map((t) => [t.name, t.path])).toEqual([
          ["read", "story-beats.md"],
          ["write", "story-beats.md"],
          ["write", "quest-log.md"],
        ]);
      }

      // one light pass, briefed on the new transcript lines
      expect(hygienePasses(gm.calls)).toEqual(["light"]);
      const brief = hygieneBrief(gm.calls.find(isHygiene)!)!;
      expect(brief).toContain("[Memory Hygiene — light — hidden system pass]");
      expect(brief).toContain("transcript lines 0..3");
      // light appends beats; merging older ones is the compaction pass's job
      expect(brief).toContain("Leave older story beats as they stand");
      expect(brief).not.toContain("Merge story beats");
      expect(brief).not.toContain("twists.md is rethought");
      for (const line of [
        "private plan for where the story could go",
        "Keep 3 to 6 unspent twists",
        "must name what would reveal it",
        "Delete a twist once it has landed",
        "quest-log.md, and twists.md",
        "new chronicle lines appended",
        "subject facts only",
        "what the next Turn must not forget",
        "open leads",
        "YAML fence",
        "`regard` from 1 to 10 on people",
        "only the allowed optional H2 sections",
        "Move chronology, encounters, recent actions, and event history to story-beats.md",
        "Use edit for existing dossiers; write only when creating a new dossier",
        "Put event history only in story-beats.md",
        "appending one compact factual beat per line",
        "not scene summaries, recent actions, or one-off reactions",
        "an explicit commitment, a lasting change, or recurring evidence",
        "without retelling the loss in the dossier",
        "preserving names, numbers, negation, causality",
        "durable relationship facts rather than memorable phrasing",
        "exact quotes only when the wording matters to a promise, clue, threat, or callback",
        "Treat existing memory as current truth",
        "do not sanitize or overwrite standing facts just because the recent transcript omits them",
      ]) {
        expect(brief).toContain(line);
      }
      expect(brief).not.toMatch(/caveman|compact shorthand|memory-file shorthand/iu);

      const rows = await readTranscript(campaign);
      expect(rows.filter((r) => r.role === "gm")).toHaveLength(2);
      expect(rows.some((r) => r.text.includes("discard me"))).toBe(false);

      const ps = await loadPlayState(campaign);
      expect(ps.success_turn_count).toBe(2);
      expect(ps.last_hygiene_status).toBe("ok");
      expect(ps.last_hygiene_mode).toBe("light");
      expect(ps.last_hygiene_transcript_line).toBe(3); // 4 rows, 0-based last index
      expect(await readFile(path.join(campaign, "story-beats.md"), "utf8")).toContain(
        "entered marsh",
      );
      expect(await readFile(path.join(campaign, "quest-log.md"), "utf8")).toContain(
        "find the bell",
      );
      // the hidden pass leaves no trace in the play history the model sees next
      const { lines } = await seededHistory(loop, gm);
      expect(lines.some((l) => l.text.includes("Memory Hygiene"))).toBe(false);
      expect(lines.some((l) => l.text.includes("discard me"))).toBe(false);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("manual hygiene resets the automatic light schedule", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      const gm = await scriptedGameMaster({ fallback: router({}) });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 3 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const started = () =>
        events.filter((e) => e.type === "hygiene_started").length;

      await loop.turn("one");
      expect(await loop.runManualHygiene("light")).toBe(true);
      expect(started()).toBe(1);

      // Turn 3 would have been an absolute multiple of N; the manual pass at
      // Turn 1 moved the next automatic Light to Turn 4.
      await loop.turn("two");
      await loop.turn("three");
      expect(started()).toBe(1);

      await loop.turn("four");
      expect(started()).toBe(2);
      expect(hygienePasses(gm.calls)).toEqual(["light", "light"]);

      const ps = await loadPlayState(campaign);
      expect(ps.success_turn_count).toBe(4);
      expect(ps.last_hygiene_success_turn).toBe(4);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("hygiene failure does not advance transcript cursor and returns Idle", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: router({
          play: says("story"),
          hygiene: () => {
            throw new Error("model refused");
          },
        }),
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 1 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const result = await loop.turn("go");
      expect(result.outcome).toBe("success");
      expect(loop.loopState).toBe("idle");
      expect(gm.calls.some(isHygiene)).toBe(true);
      const ps = await loadPlayState(campaign);
      expect(ps.last_hygiene_status).toBe("fail");
      expect(ps.last_hygiene_transcript_line).toBeUndefined();
      expect(events.some((e) => e.type === "error")).toBe(true);
      expect(
        events.some((e) => e.type === "hygiene_ended" && !e.ok),
      ).toBe(true);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("no hygiene on FAIL", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      // the Game Master never says anything
      const gm = await scriptedGameMaster({ fallback: () => {} });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 1 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const result = await loop.turn("x");
      expect(result.outcome).toBe("fail");
      expect(result.reason).toBe("empty_prose");
      expect(events.some((e) => e.type === "hygiene_started")).toBe(false);
      expect(gm.calls.some(isHygiene)).toBe(false);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("rebuild-compaction: heavy hygiene then new primed session with handoff+tail", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: router({
          play: (c) =>
            c.prompt === "first"
              ? overCeiling((x) => `Beat for: ${x.prompt}`)(c)
              : c.say(`Beat for: ${c.prompt}`),
        }),
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 10, compactCeilingTokens: 128_000 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const firstSession = loop.currentSession;
      await loop.turn("first");
      expect(events).toContainEqual({ type: "context", used: OVER_CEILING, ceiling: 128_000 });
      expect(
        events.some((e) => e.type === "hygiene_started" && e.mode === "heavy"),
      ).toBe(true);
      expect(events.some((e) => e.type === "compact_ended" && e.ok)).toBe(true);
      expect(hygienePasses(gm.calls)).toEqual(["heavy"]);

      // heavy mode merges beats and rethinks the twists
      const brief = hygieneBrief(gm.calls.find(isHygiene)!)!;
      expect(brief).toContain("HEAVY MODE");
      expect(brief).toContain("Merge story beats");
      expect(brief).toContain("every name, number, quantity, negation, cause");
      expect(brief).toContain("twists.md is rethought against the current board");

      // session replaced
      expect(loop.currentSession).not.toBe(firstSession);
      // the new session starts from the pins, the tail, then the handoff
      const { lines, call } = await seededHistory(loop, gm);
      expect(call.system).toContain("## Runtime infrastructure");
      expect(call.system).toContain('<file path="story-beats.md">');
      expect(lines).toEqual([
        { role: "user", text: "first" },
        { role: "assistant", text: "Beat for: first" },
        { role: "system", text: buildHistoryHandoff("compact") },
      ]);
      const handoff = buildHistoryHandoff("compact");
      expect(handoff).toContain("recent player and Game Master dialogue is above");
      expect(handoff).toContain("Older activity is summarized in Story Beats (pinned).");
      expect(handoff).toContain(
        "Read a dossier body only when you need a fact. Chronicle belongs in Story Beats, not in a dossier.",
      );

      const ps = await loadPlayState(campaign);
      expect(ps.last_hygiene_mode).toBe("heavy");
      expect(ps.last_hygiene_status).toBe("ok");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("compact seed percent clamps the tail and warns when pins fill it", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: router({
          play: (c) =>
            c.prompt === "first"
              ? overCeiling((x) => `Beat for: ${x.prompt}`)(c)
              : c.say(`Beat for: ${c.prompt}`),
        }),
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: {
          hygieneN: 10,
          compactCeilingTokens: 128_000,
          // 1% of the ceiling is below the pins alone, so no tail survives.
          compactSeedPercent: 1,
        },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      await loop.turn("first");

      expect(events.some((e) => e.type === "compact_ended" && e.ok)).toBe(true);
      expect(
        events.some(
          (e) => e.type === "error" && e.message.includes("compact seed budget"),
        ),
      ).toBe(true);
      // Pins are never trimmed; the clamp can only take the dialogue.
      const { lines, call } = await seededHistory(loop, gm);
      expect(call.system).toContain('<file path="story-beats.md">');
      expect(lines).toEqual([
        { role: "system", text: buildHistoryHandoff("compact") },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("compact tail follows the Hygiene interval in whole Turns", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const transcript = [
        ["player", "player one"],
        ["gm", "gm one"],
        ["player", "player two"],
        ["gm", "gm two"],
        ["player", "player three"],
        ["gm", "gm three"],
      ] as const;
      for (let i = 0; i < transcript.length; i++) {
        const [role, text] = transcript[i]!;
        await appendTranscriptRow(campaign, {
          role,
          text,
          ts: `2026-01-01T00:00:0${i}.000Z`,
        });
      }

      const gm = await scriptedGameMaster({ fallback: router({}) });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 2 },
      });
      await loop.open();

      expect(await loop.runManualHygiene("compact")).toBe(true);
      expect(hygienePasses(gm.calls)).toEqual(["heavy"]);
      const { lines } = await seededHistory(loop, gm);
      expect(lines).toEqual([
        { role: "user", text: "player two" },
        { role: "assistant", text: "gm two" },
        { role: "user", text: "player three" },
        { role: "assistant", text: "gm three" },
        { role: "system", text: buildHistoryHandoff("compact") },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("fresh rebuild seeds the handoff with no transcript rows", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const transcript = [
        ["player", "player one"],
        ["gm", "gm one"],
        ["player", "player two"],
        ["gm", "gm two"],
      ] as const;
      for (let i = 0; i < transcript.length; i++) {
        const [role, text] = transcript[i]!;
        await appendTranscriptRow(campaign, {
          role,
          text,
          ts: `2026-01-01T00:00:0${i}.000Z`,
        });
      }

      const gm = await scriptedGameMaster({ fallback: router({}) });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 10 },
      });
      await loop.open();
      const onDisk = await readTranscript(campaign);

      expect(await loop.runManualHygiene("fresh")).toBe(true);
      expect(await readTranscript(campaign)).toHaveLength(onDisk.length);
      const history = await listCampaignHistory(campaign);
      expect(history[0]?.message).toBe("fresh");

      const { lines } = await seededHistory(loop, gm);
      expect(lines).toEqual([
        { role: "system", text: buildHistoryHandoff("fresh") },
      ]);
      const handoff = buildHistoryHandoff("fresh");
      expect(handoff).toContain("This session has no prior player or Game Master dialogue.");
      expect(handoff).not.toContain("dialogue is above");
      expect(
        handoff.endsWith(
          "Continue as Game Master using the current system voice. Reply only with finished story prose.",
        ),
      ).toBe(true);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("heavy hygiene failure aborts compact and keeps session", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: router({
          play: (c) =>
            c.prompt === "x" ? overCeiling(() => "story")(c) : c.say("more story"),
          hygiene: () => {
            throw new Error("heavy failed");
          },
        }),
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { compactCeilingTokens: 128_000 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const session = loop.currentSession;
      await loop.turn("x");
      expect(hygienePasses(gm.calls)).toEqual(["heavy"]);
      expect(loop.currentSession).toBe(session);
      expect(events.some((e) => e.type === "compact_ended" && !e.ok)).toBe(true);
      expect(loop.loopState).toBe("idle");
      // the kept session still holds the full history, no rebuild handoff
      const { lines } = await seededHistory(loop, gm);
      expect(lines).toEqual([
        { role: "user", text: "x" },
        { role: "assistant", text: "story" },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("when light and heavy both due, heavy only", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: router({ play: overCeiling(() => "story") }),
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 1, compactCeilingTokens: 128_000 },
      });
      await loop.open();
      await loop.turn("x");
      expect(hygienePasses(gm.calls)).toEqual(["heavy"]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("runHygienePass runs hidden hygiene from Idle without a play Turn", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: router({
          play: says("should not play"),
          hygiene: hygieneWrites({ "story-beats.md": "- eval hook fired\n" }, "discard"),
        }),
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const ok = await loop.runHygienePass("light");
      expect(ok).toBe(true);
      expect(loop.loopState).toBe("idle");
      expect(
        events.some((e) => e.type === "hygiene_started" && e.mode === "light"),
      ).toBe(true);
      expect(hygienePasses(gm.calls)).toEqual(["light"]);
      expect(gm.calls.every(isHygiene)).toBe(true);
      const rows = await readTranscript(campaign);
      expect(rows.some((r) => r.text.includes("discard"))).toBe(false);
      expect(await readFile(path.join(campaign, "story-beats.md"), "utf8")).toContain(
        "eval hook fired",
      );
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("runRebuildCompaction uses the eval hook without a play Turn", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: router({ play: says("should not play") }),
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const session = loop.currentSession;
      const ok = await loop.runRebuildCompaction();
      expect(ok).toBe(true);
      expect(loop.loopState).toBe("idle");
      expect(hygienePasses(gm.calls)).toEqual(["heavy"]);
      expect(gm.calls.every(isHygiene)).toBe(true);
      expect(loop.currentSession).not.toBe(session);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("manual light from Idle runs hygiene, commits, and resets the clock", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      let passes = 0;
      const gm = await scriptedGameMaster({
        fallback: router({
          play: (c) => c.say(`Echo: ${c.prompt}`),
          hygiene: (c) => {
            if (c.toolResults.length === 0) passes += 1;
            return hygieneWrites(
              { "story-beats.md": `- ${passes === 1 ? "manual" : "auto"} pass\n` },
              "discard",
            )(c);
          },
        }),
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 2 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      await loop.turn("one");
      expect(hygienePasses(gm.calls)).toEqual([]);
      const before = await listCampaignHistory(campaign);

      const ok = await loop.runManualHygiene("light");
      expect(ok).toBe(true);
      expect(loop.loopState).toBe("idle");
      expect(hygienePasses(gm.calls)).toEqual(["light"]);
      expect(
        events.some((e) => e.type === "hygiene_started" && e.mode === "light"),
      ).toBe(true);
      expect(await readFile(path.join(campaign, "story-beats.md"), "utf8")).toContain(
        "manual pass",
      );
      const afterManual = await listCampaignHistory(campaign);
      expect(afterManual).toHaveLength(before.length + 1);
      expect(afterManual[0]?.message).toBe("light");
      expect(gm.calls.filter((c) => !isHygiene(c))).toHaveLength(1);

      // The manual pass at Turn 1 restarts the clock, so Turn 2 — an absolute
      // multiple of N — no longer triggers the automatic Light.
      await loop.turn("two");
      expect(hygienePasses(gm.calls)).toEqual(["light"]);
      const afterQuietTurn = await listCampaignHistory(campaign);
      expect(afterQuietTurn[0]?.message).toBe("turn 2");
      expect(afterQuietTurn).toHaveLength(before.length + 2);

      await loop.turn("three");
      expect(hygienePasses(gm.calls)).toEqual(["light", "light"]);
      expect(await readFile(path.join(campaign, "story-beats.md"), "utf8")).toContain(
        "auto pass",
      );
      const afterAuto = await listCampaignHistory(campaign);
      expect(afterAuto[0]?.message).toBe("turn 3");
      expect(afterAuto).toHaveLength(before.length + 3);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("manual hygiene while Turning is busy", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const entered = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        fallback: router({
          play: async (c) => {
            entered.resolve();
            await c.aborted();
          },
        }),
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const turnPromise = loop.turn("I wait.");
      await entered.promise;
      const err = await loop.runManualHygiene("heavy").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("busy");
      loop.interrupt();
      expect((await turnPromise).reason).toBe("interrupt");
      expect(loop.loopState).toBe("idle");
      expect(gm.calls.some(isHygiene)).toBe(false);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("manual compact success rebuilds the session and commits compact", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: router({
          play: says("A beat."),
          hygiene: hygieneWrites({ "story-beats.md": "- manual compact\n" }, "heavy ok"),
        }),
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const session = loop.currentSession;
      const before = await listCampaignHistory(campaign);

      const ok = await loop.runManualHygiene("compact");
      expect(ok).toBe(true);
      expect(loop.loopState).toBe("idle");
      expect(hygienePasses(gm.calls)).toEqual(["heavy"]);
      expect(loop.currentSession).not.toBe(session);
      expect(
        events.some((e) => e.type === "hygiene_started" && e.mode === "heavy"),
      ).toBe(true);
      expect(events.some((e) => e.type === "compact_ended" && e.ok)).toBe(true);
      expect(await readFile(path.join(campaign, "story-beats.md"), "utf8")).toContain(
        "manual compact",
      );
      const after = await listCampaignHistory(campaign);
      expect(after).toHaveLength(before.length + 1);
      expect(after[0]?.message).toBe("compact");
      const ps = await loadPlayState(campaign);
      expect(ps.last_hygiene_mode).toBe("heavy");
      expect(ps.last_hygiene_status).toBe("ok");

      const { lines, call } = await seededHistory(loop, gm);
      expect(lines.at(-1)).toEqual({
        role: "system",
        text: buildHistoryHandoff("compact"),
      });
      // the rebuilt session pins the freshly written beats
      expect(call.system).toContain("- manual compact");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("manual compact aborts if heavy hygiene fails: no rebuild, no commit", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: router({
          hygiene: () => {
            throw new Error("heavy failed");
          },
        }),
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const session = loop.currentSession;
      const before = await listCampaignHistory(campaign);
      const ok = await loop.runManualHygiene("compact");
      expect(ok).toBe(false);
      expect(loop.loopState).toBe("idle");
      expect(loop.currentSession).toBe(session);
      expect(hygienePasses(gm.calls)).toEqual(["heavy"]);
      expect(events.some((e) => e.type === "compact_ended" && !e.ok)).toBe(true);
      expect(events.some((e) => e.type === "compact_ended" && e.ok)).toBe(false);
      expect(events.some((e) => e.type === "error")).toBe(true);
      const ps = await loadPlayState(campaign);
      expect(ps.last_hygiene_status).toBe("fail");
      expect(ps.last_hygiene_transcript_line).toBeUndefined();
      expect(await listCampaignHistory(campaign)).toEqual(before);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("overlapping startHygiene locks so only one is accepted", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        fallback: router({
          hygiene: async (c) => {
            entered.resolve();
            await release.promise;
            c.say("ok");
          },
        }),
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.startHygiene("light");
      await entered.promise;
      const err = await loop.startHygiene("heavy").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("busy");
      release.resolve();
      await waitFor(() => loop.loopState === "idle", "hygiene to finish");
      expect(hygienePasses(gm.calls)).toEqual(["light"]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
