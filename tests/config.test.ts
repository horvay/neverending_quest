import { describe, expect, test } from "bun:test";
import { mergeConfig, parseConfigToml } from "../src/config.ts";
import { readTranscript } from "../src/campaign/index.ts";
import { PlayLoop } from "../src/play/index.ts";
import { birthCampaign } from "./helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "./helpers/fs.ts";
import { scriptedGameMaster, says } from "./helpers/game_master.ts";

describe("user config + flags", () => {
  test("PlayLoop honors timeout and hygieneN from merged config", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      // the model never answers; only the configured timeout can end the Turn
      const gm = await scriptedGameMaster({
        steps: [
          async (c) => {
            c.say("The fog");
            await c.aborted();
          },
        ],
        fallback: says("hygiene"),
      });
      const file = parseConfigToml(`timeout = 1\n[hygiene]\nn = 1\n`);
      const config = mergeConfig(file, { timeoutSec: 0.05 }); // 50ms wins
      expect(config.hygieneN).toBe(1);
      expect(config.turnTimeoutMs).toBe(50);
      const loop = new PlayLoop({ path: campaign, factory: gm.factory, config });
      await loop.open();
      const result = await loop.turn("slow");
      expect(result.outcome).toBe("fail");
      expect(result.reason).toBe("timeout");
      // hygieneN from file is 1, but FAIL skips hygiene: counter 0, and no
      // hidden Memory Hygiene pass reached the model
      expect(loop.currentPlayState.success_turn_count).toBe(0);
      expect(gm.calls.map((c) => c.prompt)).toEqual(["slow"]);
      expect((await readTranscript(campaign)).map((r) => r.role)).toEqual([
        "player",
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("play transcript tail length is configurable", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: mergeConfig({}, { tail: 2 }),
      });
      await loop.open();
      await loop.turn("1");
      await loop.turn("2");
      await loop.turn("3");
      expect(loop.currentPlayState.success_turn_count).toBe(3);
      // the flag beats the file, and the Play Loop's story tail honors it
      const cfg = mergeConfig({ playTranscriptTailRows: 20 }, { tail: 2 });
      expect(cfg.playTranscriptTailRows).toBe(2);
      expect(await readTranscript(campaign)).toHaveLength(6);
      const story = await loop.snapshotStory();
      expect(story.map((r) => [r.role, r.text])).toEqual([
        ["player", "3"],
        ["gm", "ok"],
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
