import { describe, expect, test } from "bun:test";
import {
  listCampaignHistory,
  loadPlayState,
  readTranscript,
} from "../../src/campaign/index.ts";
import { PlayLoop, type PlayEvent } from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import {
  scriptedGameMaster,
  says,
  type ModelCall,
  type ScriptStep,
} from "../helpers/game_master.ts";

/** Streams `prose`, lets the test know, then keeps "writing" until Stop. */
function streamThenHang(
  prose: string[],
  streamed: PromiseWithResolvers<void>,
): ScriptStep {
  return async (c) => {
    for (const piece of prose) c.say(piece);
    streamed.resolve();
    await c.aborted();
  };
}

/**
 * Resolves once the Play Loop has shown the player `text` (its prose_delta
 * events, joined), i.e. once the streamed words reached the live draft.
 */
function shown(text: string): {
  onEvent: (e: PlayEvent) => void;
  promise: Promise<void>;
} {
  const { promise, resolve } = Promise.withResolvers<void>();
  let draft = "";
  return {
    promise,
    onEvent: (e) => {
      if (e.type === "prose_reset") draft = "";
      if (e.type !== "prose_delta") return;
      draft += e.text;
      if (draft.includes(text)) resolve();
    },
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : ""))
    .join("");
}

/** What the model was sent, as role/text pairs. */
function dialogue(call: ModelCall): Array<[string, string]> {
  return call.context.messages.map((m) => [
    m.role,
    textOf((m as { content?: unknown }).content),
  ]);
}

describe("Stop keeps the streamed reply", () => {
  test("Stop after prose → GM row holds the partial reply", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const streamed = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        steps: [
          streamThenHang(["The door creaks open, and ", "a lantern swings  "], streamed),
          says("The lantern steadies."),
        ],
      });
      const draft = shown("a lantern swings");
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: draft.onEvent,
      });
      await loop.open();
      const torn = loop.currentSession;
      const turn = loop.turn("I push the door.");
      await draft.promise;
      loop.interrupt();
      const result = await turn;

      expect(result.outcome).toBe("success");
      expect(result.stopped).toBe(true);
      expect(result.prose).toBe("The door creaks open, and a lantern swings");
      expect((await readTranscript(campaign)).at(-1)).toMatchObject({
        role: "gm",
        text: "The door creaks open, and a lantern swings",
      });
      expect((await loadPlayState(campaign)).success_turn_count).toBe(1);
      expect((await listCampaignHistory(campaign))[0]?.message).toMatch(
        /^turn 1/,
      );
      // the torn session is replaced by one primed from the transcript: the
      // next Turn's model sees the kept reply, not the aborted message
      expect(loop.currentSession).not.toBe(torn);
      await loop.turn("I step inside.");
      const next = dialogue(gm.calls[1]!);
      expect(next.slice(0, 2)).toEqual([
        ["user", "I push the door."],
        ["assistant", "The door creaks open, and a lantern swings"],
      ]);
      expect(next.at(-1)).toEqual(["user", "I step inside."]);
      expect(
        next.filter(([, text]) => text.includes("a lantern swings  ")),
      ).toEqual([]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("Stop with no visible prose still FAILs", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const streamed = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        steps: [
          // narration before a tool call is withdrawn when the tool runs
          (c) => {
            c.think("Hmm.");
            c.say("Let me check the map.");
            c.tool("read", { path: "player_sheet.md" });
          },
          streamThenHang([], streamed),
        ],
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const turn = loop.turn("Where am I?");
      await streamed.promise;
      loop.interrupt();
      const result = await turn;

      expect(events.some((e) => e.type === "prose_reset")).toBe(true);
      expect(result.outcome).toBe("fail");
      expect(result.reason).toBe("interrupt");
      expect((await readTranscript(campaign)).map((r) => r.role)).toEqual([
        "player",
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("timeout after prose still FAILs", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [streamThenHang(["Half a thought"], Promise.withResolvers<void>())],
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        // inactivity timeout: it runs out once the model goes quiet
        config: { turnTimeoutMs: 100 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const result = await loop.turn("wait");
      expect(
        events.some((e) => e.type === "prose_delta" && e.text === "Half a thought"),
      ).toBe(true);
      expect(result.outcome).toBe("fail");
      expect(result.reason).toBe("timeout");
      expect((await readTranscript(campaign)).map((r) => r.role)).toEqual([
        "player",
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("Stop during Continue keeps the extension", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const streamed = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        steps: [
          says("And then he"),
          streamThenHang(["walks into the rain"], streamed),
        ],
      });
      const draft = shown("walks into the rain");
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: draft.onEvent,
      });
      await loop.open();
      await loop.turn("I wait.");
      const cont = loop.continueFromTurn(1);
      await draft.promise;
      loop.interrupt();
      const result = await cont;

      expect(result.outcome).toBe("success");
      expect(result.stopped).toBe(true);
      expect((await readTranscript(campaign)).at(-1)).toMatchObject({
        role: "gm",
        text: "And then he walks into the rain",
      });
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
