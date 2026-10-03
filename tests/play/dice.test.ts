import { describe, expect, test } from "bun:test";
import { readScratch } from "../../src/campaign/index.ts";
import { PlayLoop, type PlayEvent } from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster } from "../helpers/game_master.ts";

describe("Play Loop roll events", () => {
  test("emits roll for a standard die and ignores the rest", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      // the real `roll` tool rolls through the Campaign sandbox
      // OMP runs both rolls in parallel, so results are matched by call id
      let bladeId = "";
      let oddId = "";
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            bladeId = c.tool("roll", { n: 20, reason: "The blade" });
            oddId = c.tool("roll", { n: 7 });
          },
          (c) => {
            const blade = c.toolResults.find((r) => r.id === bladeId);
            c.say(`The blade rings (${blade?.text}).`);
          },
        ],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const result = await loop.turn("I swing");
      expect(result.outcome).toBe("success");

      const results = gm.calls[1]!.toolResults;
      expect(results).toHaveLength(2);
      const d20 = results.find((r) => r.id === bladeId);
      const d7 = results.find((r) => r.id === oddId);
      expect(d20?.name).toBe("roll");
      const value = Number(d20?.text);
      expect(Number.isInteger(value) && value >= 1 && value <= 20).toBe(true);
      const odd = Number(d7?.text);
      expect(Number.isInteger(odd) && odd >= 1 && odd <= 7).toBe(true);
      // only the d20 reaches the player, with the value the model saw
      expect(events.filter((e) => e.type === "roll")).toEqual([
        { type: "roll", n: 20, value, reason: "The blade" },
      ]);
      expect(result.prose).toBe(`The blade rings (${value}).`);
      // both rolls stay in the Turn's Scratch
      const [record] = await readScratch(campaign);
      expect(record?.tools.filter((t) => t.name === "roll")).toHaveLength(2);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("uses the OMP intent when args omit the stake", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      const gm = await scriptedGameMaster({
        steps: [
          (c) => c.tool("roll", { n: 6, i: "Hallam deal generosity" }),
          (c) => c.say("Hallam does not write the paper."),
        ],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      await loop.turn("I ask for work");
      const value = Number(gm.calls[1]!.toolResults[0]?.text);
      expect(events.filter((e) => e.type === "roll")).toEqual([
        { type: "roll", n: 6, value, reason: "Hallam deal generosity" },
      ]);
      // the stake the model gave in OMP's `i` intent field is kept in Scratch
      const [record] = await readScratch(campaign);
      expect(record?.tools).toEqual([
        { name: "roll", n: 6, value, reason: "Hallam deal generosity" },
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
