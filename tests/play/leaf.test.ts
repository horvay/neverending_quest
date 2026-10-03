import { describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { PlayLoop, type PlayEvent } from "../../src/play/index.ts";
import { estimateTokensDefault } from "../../src/play/context.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster } from "../helpers/game_master.ts";

/**
 * Context occupancy is whatever the live OMP session reports. The scripted
 * model reports provider usage the way a real one does, and OMP anchors its
 * occupancy on that prompt size.
 */
function lastContext(events: PlayEvent[]) {
  return events.filter((e) => e.type === "context").at(-1);
}

describe("Play Loop context events", () => {
  test("emits context on open and after a Turn", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.usage({ input: 12_000, output: 40 });
            c.say("Mira nods.");
          },
        ],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { compactCeilingTokens: 128_000 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      // before any reply OMP estimates its system prompt, tools and pins
      const afterOpen = lastContext(events);
      expect(afterOpen).toMatchObject({ type: "context", ceiling: 128_000 });
      const opened = afterOpen as { used: number };
      expect(opened.used).toBeGreaterThan(0);
      expect(opened.used).toBeLessThan(12_000);
      events.length = 0;
      await loop.turn("I wait.");
      const afterTurn = events.filter((e) => e.type === "context");
      expect(afterTurn.length).toBeGreaterThanOrEqual(1);
      // after the reply, the provider-reported prompt size is ground truth
      expect(afterTurn.at(-1)).toEqual({
        type: "context",
        used: 12_000,
        ceiling: 128_000,
      });
      expect(loop.contextUsage).toEqual({ used: 12_000, ceiling: 128_000 });
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("used is OMP session occupancy, not the transcript estimate", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const fat = "x".repeat(80_000);
      await appendFile(
        join(campaign, "transcript.jsonl"),
        `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", role: "player", text: fat })}\n`,
      );
      const events: PlayEvent[] = [];
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.usage({ input: 5_000 });
            c.say("Mira nods.");
          },
        ],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { compactCeilingTokens: 80_000 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      await loop.turn("I wait.");
      // the transcript alone estimates far above what the session holds
      expect(estimateTokensDefault(fat)).toBe(20_000);
      expect(lastContext(events)).toEqual({
        type: "context",
        used: 5_000,
        ceiling: 80_000,
      });
      expect(loop.contextUsage?.used).toBe(5_000);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("used comes from the OMP session; ceiling stays compact.ceiling", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.usage({ input: 20_000, cacheRead: 4_000 });
            c.say("Mira nods.");
          },
        ],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { compactCeilingTokens: 80_000 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      await loop.turn("I wait.");
      // cached prompt tokens still occupy the context
      expect(lastContext(events)).toEqual({
        type: "context",
        used: 24_000,
        ceiling: 80_000,
      });
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("ceiling is NQ compact.ceiling, not a model window", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      const gm = await scriptedGameMaster({
        contextWindow: 128_000,
        steps: [
          (c) => {
            c.usage({ input: 20_000 });
            c.say("Mira nods.");
          },
        ],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { compactCeilingTokens: 80_000 },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      await loop.turn("I wait.");
      expect(lastContext(events)).toEqual({
        type: "context",
        used: 20_000,
        ceiling: 80_000,
      });
      expect(loop.contextUsage?.ceiling).toBe(80_000);
      expect(loop.contextUsage?.ceiling).not.toBe(128_000);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
