import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  appendTranscriptRow,
  CampaignError,
  deleteLastTranscript,
  editTranscriptText,
  listGmTurns,
  listHistorySnapshots,
  readTranscript,
  STORY_BEATS_MD,
} from "../../src/campaign/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";

describe("transcript edit / delete helpers", () => {
  test("edit mid-log changes text only; later rows stay", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const first = await appendTranscriptRow(campaign, {
        role: "player",
        text: "I wait.",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const mid = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "Fog thickens.",
        ts: "2026-01-01T00:00:01.000Z",
      });
      const last = await appendTranscriptRow(campaign, {
        role: "player",
        text: "I keep walking.",
        ts: "2026-01-01T00:00:02.000Z",
      });
      await Bun.write(path.join(campaign, STORY_BEATS_MD), "- old beat\n");

      const edited = await editTranscriptText(
        campaign,
        mid.ts,
        "Fog lifts off the dock.",
      );
      expect(edited).toEqual({
        ts: mid.ts,
        role: "gm",
        text: "Fog lifts off the dock.",
      });

      const rows = await readTranscript(campaign);
      expect(rows).toEqual([
        first,
        { ts: mid.ts, role: "gm", text: "Fog lifts off the dock." },
        last,
      ]);
      expect(await readFile(path.join(campaign, STORY_BEATS_MD), "utf8")).toBe(
        "- old beat\n",
      );
    } finally {
      await rmTempDir(root);
    }
  });

  test("edit opening GM row keeps ts and role", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const opening = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "Mira watches the door.",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const edited = await editTranscriptText(
        campaign,
        opening.ts,
        "Mira watches the Salt Lamp door.",
      );
      expect(edited.ts).toBe(opening.ts);
      expect(edited.role).toBe("gm");
      expect((await readTranscript(campaign))[0]).toEqual(edited);
    } finally {
      await rmTempDir(root);
    }
  });

  test("delete last pair removes player+GM tail", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const keepP = await appendTranscriptRow(campaign, {
        role: "player",
        text: "first",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const keepG = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "reply",
        ts: "2026-01-01T00:00:01.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "player",
        text: "second",
        ts: "2026-01-01T00:00:02.000Z",
      });
      const lastGm = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "later",
        ts: "2026-01-01T00:00:03.000Z",
      });

      const deleted = await deleteLastTranscript(campaign, lastGm.ts);
      expect(deleted.map((r) => r.text)).toEqual(["second", "later"]);
      expect(await readTranscript(campaign)).toEqual([keepP, keepG]);
    } finally {
      await rmTempDir(root);
    }
  });

  test("delete last player-only row after a torn FAIL", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const keep = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "opening",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const orphan = await appendTranscriptRow(campaign, {
        role: "player",
        text: "I reach.",
        ts: "2026-01-01T00:00:01.000Z",
      });

      const deleted = await deleteLastTranscript(campaign);
      expect(deleted).toEqual([orphan]);
      expect(await readTranscript(campaign)).toEqual([keep]);
    } finally {
      await rmTempDir(root);
    }
  });

  test("listGmTurns numbers opening as 0 and a first play GM as 1", async () => {
    const withOpening = [
      { ts: "a", role: "gm" as const, text: "opening" },
      { ts: "b", role: "player" as const, text: "hi" },
      { ts: "c", role: "gm" as const, text: "reply" },
    ];
    expect(listGmTurns(withOpening).map((t) => t.turn)).toEqual([0, 1]);
    const playOnly = [
      { ts: "b", role: "player" as const, text: "hi" },
      { ts: "c", role: "gm" as const, text: "reply" },
    ];
    expect(listGmTurns(playOnly).map((t) => t.turn)).toEqual([1]);
  });

  test("listHistorySnapshots is turn + short prose, not a SHA", () => {
    const long =
      "Mira looks at your hands, not your face. Attic is yours if you haul the lemon crate from Kell's slip before the fog sits.";
    const entries = listHistorySnapshots([
      { ts: "a", role: "gm", text: "Fog on the water.\n\nWhat do you do?" },
      { ts: "b", role: "player", text: "I wait." },
      { ts: "c", role: "gm", text: long },
    ]);
    expect(entries.map((e) => e.turn)).toEqual([0, 1]);
    expect(entries[0]?.prose).toBe("Fog on the water. What do you do?");
    expect(entries[1]?.prose.endsWith("…")).toBe(true);
    expect(entries[1]!.prose.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(entries)).not.toMatch(/[a-f0-9]{40}/);
  });

  test("edit unknown ts is not_found", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "opening",
        ts: "2026-01-01T00:00:00.000Z",
      });
      let err: unknown;
      try {
        await editTranscriptText(campaign, "missing", "nope");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("not_found");
      expect((await readTranscript(campaign))[0]?.text).toBe("opening");
    } finally {
      await rmTempDir(root);
    }
  });

  test("delete on an empty transcript is not_last", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      expect(await readTranscript(campaign)).toEqual([]);
      let err: unknown;
      try {
        await deleteLastTranscript(campaign);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("not_last");
    } finally {
      await rmTempDir(root);
    }
  });

  test("delete last GM-only row (opening) does not require a pair", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const opening = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "opening",
        ts: "2026-01-01T00:00:00.000Z",
      });
      expect(await deleteLastTranscript(campaign, opening.ts)).toEqual([opening]);
      expect(await readTranscript(campaign)).toEqual([]);
    } finally {
      await rmTempDir(root);
    }
  });

  test("delete last of two GM rows removes only the tail GM", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const first = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "opening",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const second = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "continued",
        ts: "2026-01-01T00:00:01.000Z",
      });
      expect(await deleteLastTranscript(campaign, second.ts)).toEqual([second]);
      expect(await readTranscript(campaign)).toEqual([first]);
    } finally {
      await rmTempDir(root);
    }
  });

  test("delete accepts the last player ts of a finished pair", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const keep = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "opening",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const player = await appendTranscriptRow(campaign, {
        role: "player",
        text: "I wait.",
        ts: "2026-01-01T00:00:01.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "Fog answers.",
        ts: "2026-01-01T00:00:02.000Z",
      });
      const deleted = await deleteLastTranscript(campaign, player.ts);
      expect(deleted.map((r) => r.role)).toEqual(["player", "gm"]);
      expect(await readTranscript(campaign)).toEqual([keep]);
    } finally {
      await rmTempDir(root);
    }
  });

  test("mid-log delete is refused", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const first = await appendTranscriptRow(campaign, {
        role: "player",
        text: "one",
        ts: "2026-01-01T00:00:00.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "two",
        ts: "2026-01-01T00:00:01.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "player",
        text: "three",
        ts: "2026-01-01T00:00:02.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "four",
        ts: "2026-01-01T00:00:03.000Z",
      });

      let err: unknown;
      try {
        await deleteLastTranscript(campaign, first.ts);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("not_last");
      expect(await readTranscript(campaign)).toHaveLength(4);
    } finally {
      await rmTempDir(root);
    }
  });
});
