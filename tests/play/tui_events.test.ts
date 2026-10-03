import { describe, expect, test } from "bun:test";
import { PlayLoop, type PlayEvent } from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster } from "../helpers/game_master.ts";

describe("play TUI event surface", () => {
  test("PlayLoop events drive story-only deltas without tool noise", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const seen: PlayEvent[] = [];
      // the Game Master reads a file mid-Turn: that must not leak into prose
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.think("Check the sheet.");
            c.tool("read", { path: "player_sheet.md" });
          },
          (c) => {
            c.say("The gate ");
            c.say("creaks.");
          },
        ],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => seen.push(e),
      });
      await loop.open();
      await loop.turn("open the gate");
      const prose = seen
        .filter((e) => e.type === "prose_delta")
        .map((e) => (e as { text: string }).text)
        .join("");
      expect(prose).toBe("The gate creaks.");
      expect(prose).not.toContain("weary ranger");
      expect(seen.some((e) => e.type === "turn_ended" && e.outcome === "success")).toBe(
        true,
      );
      // no tool events on default surface
      expect(seen.every((e) => e.type !== "agent_debug")).toBe(true);
      expect(seen.some((e) => (e.type as string) === "tool_call")).toBe(false);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
