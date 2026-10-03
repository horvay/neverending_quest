import { describe, expect, test } from "bun:test";
import { readScratch } from "../../src/campaign/index.ts";
import { PlayLoop, type PlayEvent } from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster } from "../helpers/game_master.ts";

describe("repetition retries", () => {
  test("a retry is judged on its own thinking, not the looped attempt's", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [
          // a decoder stuck in a loop: keeps going until the Play Loop cuts it
          async (c) => {
            for (let i = 0; i < 80; i++) c.think("la la la ");
            await c.aborted();
          },
          (c) => {
            c.think("The player opens the door.");
            c.say("The door swings open.");
          },
        ],
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const result = await loop.turn("I open the door.");

      expect(gm.calls.map((c) => c.prompt)).toEqual([
        "I open the door.",
        "I open the door.",
      ]);
      expect(result.outcome).toBe("success");
      expect(result.prose).toBe("The door swings open.");
      expect(
        events.some(
          (e) => e.type === "status" && /retrying \(2 of 3\)/.test(e.message),
        ),
      ).toBe(true);
      // the kept Scratch is the retry's own thinking
      const [record] = await readScratch(campaign);
      expect(record?.thinking).toBe("The player opens the door.");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
