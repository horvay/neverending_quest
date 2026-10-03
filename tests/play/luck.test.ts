import { describe, expect, test } from "bun:test";
import { loadPlayState, savePlayState } from "../../src/campaign/index.ts";
import { PlayLoop, type PlayEvent } from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import {
  scriptedGameMaster,
  says,
  type ModelCall,
  type ScriptStep,
} from "../helpers/game_master.ts";

/**
 * Rolls happen the way they do in play: the Game Master calls the real `roll`
 * tool, which rolls through the Campaign sandbox and the Play Loop's Luck
 * resolution. Only the entropy source is fixed, so the outcomes are known.
 */
function rollSteps(
  dice: number[],
  seen: Array<{ result: string; luck: number; armed: boolean }>,
  loop: () => PlayLoop,
): ScriptStep[] {
  const note = (c: ModelCall) => {
    const last = c.toolResults.at(-1);
    if (!last) return;
    const state = loop().currentPlayState;
    seen.push({ result: last.text, luck: state.luck_points, armed: state.luck_armed });
  };
  return [
    ...dice.map((n) => (c: ModelCall) => {
      note(c);
      c.tool("roll", { n });
    }),
    (c: ModelCall) => {
      note(c);
      c.say("The dice settle.");
    },
  ];
}

describe("Luck Point resolution", () => {
  test("restores one point for every natural roll at or below five percent", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const randomValues = [0, 0.04, 0.05, 0, 0.05];
      const seen: Array<{ result: string; luck: number; armed: boolean }> = [];
      let loop!: PlayLoop;
      const gm = await scriptedGameMaster({
        steps: rollSteps([4, 100, 100, 7, 20], seen, () => loop),
      });
      loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        random: () => randomValues.shift()!,
      });
      await loop.open();
      expect((await loop.turn("I roll the bones.")).outcome).toBe("success");

      expect(seen.map((s) => [Number(s.result), s.luck])).toEqual([
        [1, 6],
        [5, 7],
        [6, 7],
        [1, 8],
        [2, 8],
      ]);
      expect((await loadPlayState(campaign)).luck_points).toBe(8);
      await loop.close();

      const reloaded = new PlayLoop({
        path: campaign,
        factory: (await scriptedGameMaster({ fallback: says("unused") })).factory,
      });
      await reloaded.open();
      expect(reloaded.currentPlayState).toMatchObject({
        luck_points: 8,
        luck_armed: false,
      });
      await reloaded.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("spends an armed point before restoring a qualifying forced d1", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      let randomCalls = 0;
      const seen: Array<{ result: string; luck: number; armed: boolean }> = [];
      let loop!: PlayLoop;
      const gm = await scriptedGameMaster({
        steps: [
          ...rollSteps([0, 20], seen, () => loop),
          ...rollSteps([1], seen, () => loop),
        ],
      });
      const events: PlayEvent[] = [];
      loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        random: () => {
          randomCalls += 1;
          return 0;
        },
        onEvent: (e) => events.push(e),
      });
      await loop.open();

      await loop.setLuckArmed(true);
      expect((await loop.turn("I leap the chasm.")).outcome).toBe("success");
      // d0 is refused by the sandbox and costs nothing; the armed d20 is a 20
      expect(seen[0]!.result).toMatch(/roll n must be a positive integer/);
      expect(seen[0]).toMatchObject({ luck: 5, armed: true });
      expect(seen[1]).toEqual({ result: "20", luck: 4, armed: false });
      expect(
        events.filter((e) => e.type === "roll").map((e) => [e.n, e.value]),
      ).toEqual([[20, 20]]);

      await loop.setLuckArmed(true);
      expect((await loop.turn("Again.")).outcome).toBe("success");
      expect(seen[2]).toEqual({ result: "1", luck: 4, armed: false });
      expect(randomCalls).toBe(0);
      expect(await loadPlayState(campaign)).toMatchObject({
        luck_points: 4,
        luck_armed: false,
      });
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("arming luck follows the on-disk count, not a stale in-memory zero", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: says("unused") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await savePlayState(campaign, {
        success_turn_count: 0,
        luck_points: 0,
        luck_armed: false,
      });
      await loop.close();
      await loop.open();
      expect(loop.currentPlayState.luck_points).toBe(0);

      await savePlayState(campaign, {
        success_turn_count: 0,
        luck_points: 5,
        luck_armed: false,
      });
      await loop.setLuckArmed(true);
      expect(loop.currentPlayState).toMatchObject({
        luck_points: 5,
        luck_armed: true,
      });
      expect(await loadPlayState(campaign)).toMatchObject({
        luck_points: 5,
        luck_armed: true,
      });
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("a Luck Point armed before Retry stays armed for the retried Turn", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const seen: Array<{ result: string; luck: number; armed: boolean }> = [];
      let loop!: PlayLoop;
      const gm = await scriptedGameMaster({
        steps: [
          ...rollSteps([20], seen, () => loop),
          ...rollSteps([20], seen, () => loop),
        ],
      });
      const events: PlayEvent[] = [];
      loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        random: () => 0.5,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      expect((await loop.turn("I climb the sea wall.")).outcome).toBe("success");
      expect(seen[0]).toEqual({ result: "11", luck: 5, armed: false });

      // the climb went badly: arm a point, then play the same Turn again
      await loop.setLuckArmed(true);
      const gmRow = events.findLast((e) => e.type === "turn_ended");
      const ended = events.length;
      await loop.startRetryTranscript(gmRow?.type === "turn_ended" ? gmRow.ts! : "");
      while (!events.slice(ended).some((e) => e.type === "turn_ended")) {
        await Bun.sleep(5);
      }
      expect(seen[1]).toEqual({ result: "20", luck: 4, armed: false });
      expect(await loadPlayState(campaign)).toMatchObject({
        luck_points: 4,
        luck_armed: false,
      });
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
