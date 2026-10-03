import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { newCampaign, readTranscript } from "../../src/campaign/index.ts";
import {
  MEMORY_GYM_PACK_DIR,
  birthDirtyMemoryGym,
} from "./apply_fixture.ts";
import { CANARY } from "./canaries.ts";
import { scoreCampaign, type ScoreContext } from "./score.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";

describe("Memory Gym Seed Pack + eval fixtures", () => {
  test("nq new materializes the gym pack", async () => {
    const root = await makeTempDir();
    try {
      const campaign = path.join(root, "gym");
      await newCampaign({ path: campaign, packDir: MEMORY_GYM_PACK_DIR });
      const seed = await readFile(path.join(campaign, "seed.md"), "utf8");
      expect(seed).toContain("Brinewatch");
      expect(seed).toContain("## Opening message");
      const sheet = await readFile(path.join(campaign, "player_sheet.md"), "utf8");
      expect(sheet).toContain("## Powers");
      expect(sheet).toContain(CANARY.power);
      expect(await readFile(path.join(campaign, "dossiers/mira-venn.md"), "utf8")).toContain(
        "Mira Venn",
      );
      expect(await readTranscript(campaign)).toEqual([]);
    } finally {
      await rmTempDir(root);
    }
  });

  test("dirty overlay plants canaries and fails pre-hygiene scores", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthDirtyMemoryGym(root);
      const sheet = await readFile(path.join(campaign, "player_sheet.md"), "utf8");
      expect(sheet).not.toMatch(/^##\s+Powers\s*$/m);
      expect(sheet).not.toContain(CANARY.stamp);
      const quests = await readFile(path.join(campaign, "quest-log.md"), "utf8");
      expect(quests).toContain(CANARY.lemon);
      expect(
        await readFile(path.join(campaign, "dossiers/kell.md"), "utf8"),
      ).toContain("duplicate");

      const scored = await scoreCampaign(campaign, "light");
      const failedIds = scored.hardFailed.map((c) => c.id);
      expect(failedIds).toContain("hygiene-status-ok");
      expect(failedIds).toContain("sheet-has-powers-h2");
      expect(failedIds).toContain("token-on-sheet");
      expect(failedIds).toContain("lemon-quest-gone");
      expect(scored.ok).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("scorer passes a hand-cleaned Campaign for light + heavy", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthDirtyMemoryGym(root);
      await Bun.write(
        path.join(campaign, "player_sheet.md"),
        `## Description
Ren Caldew

## Inventory
- oilskin coat
- ${CANARY.token} stamped ${CANARY.stamp}

## Powers

### ${CANARY.power}

Breathe brine mist.

## Notes

- attic pallet at Salt Lamp
`,
      );
      await Bun.write(
        path.join(campaign, "story-beats.md"),
        `- Ren arrive Brinewatch dock
- Mira give Ren a room at Salt Lamp
- Ren pull ${CANARY.token} ${CANARY.stamp} from ${CANARY.well}
- Ren give Mira lemon; errand done
`,
      );
      await Bun.write(
        path.join(campaign, "quest-log.md"),
        `- recover the ${CANARY.bellQuest} from the ${CANARY.well}
- ask Kell about the fog-neap
`,
      );
      await Bun.write(
        path.join(campaign, "world-building.md"),
        `# Brinewatch\n\nThe ${CANARY.choir}.\n`,
      );
      await Bun.write(
        path.join(campaign, "dossiers/mira-venn.md"),
        `---\nname: Mira Venn\naliases: [${CANARY.aunt}]\nkind: person\n---\nInnkeeper.\n`,
      );
      await Bun.write(
        path.join(campaign, "dossiers/kell.md"),
        `---\nname: Kell\nstub_of: kell-reed\nkind: person\n---\nSee kell-reed.\n`,
      );
      await Bun.write(
        path.join(campaign, ".nq/play_state.json"),
        `${JSON.stringify({
          success_turn_count: 10,
          last_hygiene_status: "ok",
          last_hygiene_mode: "light",
        }, null, 2)}\n`,
      );

      const light = await scoreCampaign(campaign, "light");
      expect(light.hardFailed.map((c) => c.id)).toEqual([]);
      expect(light.ok).toBe(true);

      await Bun.write(
        path.join(campaign, ".nq/play_state.json"),
        `${JSON.stringify({
          success_turn_count: 10,
          last_hygiene_status: "ok",
          last_hygiene_mode: "heavy",
        }, null, 2)}\n`,
      );
      const heavy = await scoreCampaign(campaign, "heavy");
      expect(heavy.hardFailed.map((c) => c.id)).toEqual([]);
      expect(heavy.ok).toBe(true);

      await Bun.write(
        path.join(campaign, "quest-log.md"),
        `- recover the drowned-bell from the ${CANARY.well}\n`,
      );
      const hyphen = await scoreCampaign(campaign, "heavy");
      expect(hyphen.checks.find((c) => c.id === "bell-quest-open")?.pass).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });

  test("compact scorer requires dropped tail and probe stamp", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthDirtyMemoryGym(root);
      const extra: Partial<
        Pick<ScoreContext, "probeProse" | "seedMessages" | "compactOk">
      > = {
        compactOk: true,
        probeProse: `The stamp reads ${CANARY.stamp}.`,
        seedMessages: [
          { role: "system", content: "handoff after rebuild-compaction" },
          { role: "user", content: "I stay put." },
        ],
      };
      // Dirty campaign still fails hygiene file checks; isolate compact-only ids.
      const scored = await scoreCampaign(campaign, "compact", extra);
      const byId = Object.fromEntries(scored.checks.map((c) => [c.id, c]));
      expect(byId["compact-event-ok"]?.pass).toBe(true);
      expect(byId["tail-dropped-stamp"]?.pass).toBe(true);
      expect(byId["probe-recalls-stamp"]?.pass).toBe(true);

      extra.seedMessages = [
        { role: "assistant", content: `You found ${CANARY.stamp}` },
      ];
      extra.probeProse = "I do not remember.";
      const leak = await scoreCampaign(campaign, "compact", extra);
      const leakById = Object.fromEntries(leak.checks.map((c) => [c.id, c]));
      expect(leakById["tail-dropped-stamp"]?.pass).toBe(false);
      expect(leakById["probe-recalls-stamp"]?.pass).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });
});
