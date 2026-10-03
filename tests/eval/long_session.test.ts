import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { newCampaign, readTranscript } from "../../src/campaign/index.ts";
import { selectTranscriptTail } from "../../src/play/context.ts";
import {
  BRINEWATCH_PACK_DIR,
  birthLongBrinewatch,
} from "./apply_fixture.ts";
import { CANARY } from "./canaries.ts";
import {
  generateLongTranscript,
  LONG_SESSION_MIN_TOKENS,
} from "./long_session.ts";
import { scoreCampaign } from "./score.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";

describe("Brinewatch long-session eval fixture", () => {
  test("nq new materializes the mid-size pack", async () => {
    const root = await makeTempDir();
    try {
      const campaign = path.join(root, "brine");
      await newCampaign({ path: campaign, packDir: BRINEWATCH_PACK_DIR });
      const seed = await readFile(path.join(campaign, "seed.md"), "utf8");
      expect(seed).toContain("Grey Spit");
      expect(await readFile(path.join(campaign, "dossiers/jess-pike.md"), "utf8")).toContain(
        "Jess Pike",
      );
      expect(await readFile(path.join(campaign, "dossiers/holt-gann.md"), "utf8")).toContain(
        "Holt Gann",
      );
      expect(await readTranscript(campaign)).toEqual([]);
    } finally {
      await rmTempDir(root);
    }
  });

  test("generated log is ≥ 40k tokens and a ten-Turn tail drops the stamp", () => {
    const gen = generateLongTranscript();
    expect(gen.tokens).toBeGreaterThanOrEqual(LONG_SESSION_MIN_TOKENS);
    expect(gen.rows.some((r) => r.text.includes(CANARY.stamp))).toBe(true);

    const tail = selectTranscriptTail(gen.rows, {
      maxTurns: 10,
      maxTokens: Number.MAX_SAFE_INTEGER,
    });
    expect(tail.some((r) => r.text.includes(CANARY.stamp))).toBe(false);
    expect(tail.length).toBeGreaterThan(0);
  });

  test("long birth plants rot and fails pre-hygiene compact scores", async () => {
    const root = await makeTempDir();
    try {
      const { campaign, transcriptTokens } = await birthLongBrinewatch(root);
      expect(transcriptTokens).toBeGreaterThanOrEqual(LONG_SESSION_MIN_TOKENS);
      const sheet = await readFile(path.join(campaign, "player_sheet.md"), "utf8");
      expect(sheet).not.toMatch(/^##\s+Powers\s*$/m);
      expect(sheet).not.toContain(CANARY.stamp);
      const rows = await readTranscript(campaign);
      expect(rows.some((r) => r.text.includes(CANARY.stamp))).toBe(true);
      expect(rows.some((r) => r.text.includes(CANARY.ledger))).toBe(true);

      const scored = await scoreCampaign(campaign, "long");
      const failedIds = scored.hardFailed.map((c) => c.id);
      expect(failedIds).toContain("hygiene-status-ok");
      expect(failedIds).toContain("token-on-sheet");
      expect(failedIds).toContain("sheet-has-powers-h2");
      expect(scored.checks.find((c) => c.id === "transcript-min-tokens")?.pass).toBe(
        true,
      );
    } finally {
      await rmTempDir(root);
    }
  });
});
