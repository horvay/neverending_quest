import { describe, expect, test } from "bun:test";
import {
  ensureOpeningTranscript,
  readTranscript,
} from "../../src/campaign/index.ts";
import { PlayLoop } from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster, says } from "../helpers/game_master.ts";

const SEED_WITH_OPENING = `# Voice

Speak sparsely.

## Opening message

Dust lifts off the arena stones.

Kel watches the gate.

## Memory

Keep files current.
`;

describe("opening transcript on fresh Campaign", () => {
  test("ensureOpeningTranscript writes gm row once from seed section", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { seed: SEED_WITH_OPENING });
      expect(await readTranscript(campaign)).toEqual([]);

      const first = await ensureOpeningTranscript(campaign);
      expect(first.seeded).toBe(true);
      expect(first.openingText).toBe(
        "Dust lifts off the arena stones.\n\nKel watches the gate.",
      );
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]).toMatchObject({
        role: "gm",
        text: "Dust lifts off the arena stones.\n\nKel watches the gate.",
      });

      const second = await ensureOpeningTranscript(campaign);
      expect(second.seeded).toBe(false);
      expect(second.rows).toHaveLength(1);
      expect(await readTranscript(campaign)).toHaveLength(1);
    } finally {
      await rmTempDir(root);
    }
  });

  test("PlayLoop.open seeds opening message before Idle", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { seed: SEED_WITH_OPENING });
      const gm = await scriptedGameMaster({ fallback: says("The gate creaks.") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      // seeded from the pack without asking the model
      expect(gm.calls).toHaveLength(0);
      const rows = await readTranscript(campaign);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe("gm");
      expect(rows[0]?.text).toContain("arena stones");
      // the opening is committed, and the first Turn lands after it
      const log = await Bun.$`git -C ${campaign} log --format=%s`.quiet().text();
      expect(log.split("\n")[0]).toBe("opening");
      await loop.turn("I step forward");
      expect((await readTranscript(campaign)).map((r) => r.text)).toEqual([
        "Dust lifts off the arena stones.\n\nKel watches the gate.",
        "I step forward",
        "The gate creaks.",
      ]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("no opening section leaves transcript empty", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Seed\nNo opener heading.\n",
      });
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      expect(await readTranscript(campaign)).toEqual([]);
      const log = await Bun.$`git -C ${campaign} log --format=%s`.quiet().text();
      expect(log).not.toContain("opening");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
