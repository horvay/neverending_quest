import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appendTranscriptRow,
  CampaignError,
  loadPlayState,
  newCampaign,
  openCampaign,
  savePlayState,
  showCampaign,
} from "../../src/campaign/index.ts";
import {
  makeTempDir,
  pathExists,
  readText,
  rmTempDir,
  writePack,
} from "../helpers/fs.ts";

const FIXED_NOW = new Date("2026-08-07T12:00:00.000Z");
const FIXED_ID = "11111111-2222-4333-8444-555555555555";

async function birth(root: string, name = "camp"): Promise<string> {
  const pack = path.join(root, "pack");
  const campaign = path.join(root, name);
  await writePack(pack, {
    "seed.md": "# Seed\nVoice.\n",
    "player_sheet.md":
      "## Description\nHero\n\n## Inventory\n\n## Powers\n\n## Notes\n",
    "world-building.md": "The marsh expands.\n",
    "dossiers/mira.md": "---\nname: Mira\nkind: person\n---\nA guide.\n",
  });
  await newCampaign({
    path: campaign,
    packDir: pack,
    now: () => FIXED_NOW,
    id: () => FIXED_ID,
  });
  return campaign;
}

describe("Campaign open + show", () => {
  test("open resolves path and lazy-ensures missing optional skeleton files", async () => {
    const root = await makeTempDir();
    try {
      const campaign = path.join(root, "partial");
      await mkdir(campaign, { recursive: true });
      await writeFile(
        path.join(campaign, "campaign.yaml"),
        [
          "id: abc",
          "created_at: 2026-01-01T00:00:00.000Z",
          "schema_version: 1",
          "name: partial",
          "",
        ].join("\n"),
      );
      // deliberately omit optional files; seed optional for show
      const opened = await openCampaign(campaign);
      expect(opened.meta.name).toBe("partial");
      expect(opened.hasSeed).toBe(false);
      expect(await pathExists(campaign, "player_sheet.md")).toBe(true);
      expect(await pathExists(campaign, "world-building.md")).toBe(true);
      expect(await pathExists(campaign, "dossiers")).toBe(true);
      expect(await pathExists(campaign, "story-beats.md")).toBe(true);
      expect(await pathExists(campaign, "quest-log.md")).toBe(true);
      expect(await pathExists(campaign, "twists.md")).toBe(true);
      expect(await pathExists(campaign, "transcript.jsonl")).toBe(true);
      expect(await pathExists(campaign, ".nq/sessions")).toBe(true);
      // existing content not destroyed
      expect(await readText(campaign, "campaign.yaml")).toContain("name: partial");
    } finally {
      await rmTempDir(root);
    }
  });

  test("show status prints name, id, success_turn_count, skeleton", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      await savePlayState(campaign, {
        success_turn_count: 3,
        luck_points: 4,
        luck_armed: true,
      });
      const result = await showCampaign({ path: campaign, target: "status" });
      expect(result.target).toBe("status");
      expect(result.text).toContain("name: camp");
      expect(result.text).toContain(`id: ${FIXED_ID}`);
      expect(result.text).toContain("success_turn_count: 3");
      expect(result.text).toContain("luck_points: 4");
      expect(result.text).toContain("luck_armed: yes");
      expect(result.text).toContain("seed: yes");
      expect(result.text).toContain("sheet: yes");
    } finally {
      await rmTempDir(root);
    }
  });

  test("show sheet/world/beats/quests/twists/transcript bodies", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      await writeFile(path.join(campaign, "story-beats.md"), "- entered marsh\n");
      await writeFile(path.join(campaign, "quest-log.md"), "- find Mira\n");
      await writeFile(
        path.join(campaign, "twists.md"),
        "- Mira already sold the map.\n",
      );
      await appendTranscriptRow(campaign, {
        role: "player",
        text: "I look around",
        ts: "2026-08-07T12:01:00.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "Fog coils.",
        ts: "2026-08-07T12:01:01.000Z",
      });

      expect((await showCampaign({ path: campaign, target: "sheet" })).text).toContain(
        "Hero",
      );
      expect((await showCampaign({ path: campaign, target: "world" })).text).toContain(
        "marsh expands",
      );
      expect((await showCampaign({ path: campaign, target: "beats" })).text).toContain(
        "entered marsh",
      );
      expect((await showCampaign({ path: campaign, target: "quests" })).text).toContain(
        "find Mira",
      );
      expect((await showCampaign({ path: campaign, target: "twists" })).text).toContain(
        "already sold the map",
      );
      const tr = await showCampaign({ path: campaign, target: "transcript" });
      expect(tr.text).toContain("[player] I look around");
      expect(tr.text).toContain("[gm] Fog coils.");
    } finally {
      await rmTempDir(root);
    }
  });

  test("show dossiers index and slug body", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      const index = await showCampaign({ path: campaign, target: "dossiers" });
      expect(index.text).toContain("mira — Mira");
      expect(index.text).toContain("[person]");
      expect(index.target).toBe("dossiers");
      if (index.target === "dossiers") {
        expect(index.entries?.[0]?.body).toContain("A guide.");
        expect(index.entries?.[0]?.body).not.toContain("kind: person");
      }

      const body = await showCampaign({
        path: campaign,
        target: "dossiers",
        dossierSlug: "mira",
      });
      expect(body.text).toContain("A guide.");
    } finally {
      await rmTempDir(root);
    }
  });

  test("show does not require seed.md", async () => {
    const root = await makeTempDir();
    try {
      const campaign = path.join(root, "noseed");
      await mkdir(campaign, { recursive: true });
      await writeFile(
        path.join(campaign, "campaign.yaml"),
        "id: x\ncreated_at: 2026-01-01T00:00:00.000Z\nschema_version: 1\nname: noseed\n",
      );
      const result = await showCampaign({ path: campaign });
      expect(result.text).toContain("name: noseed");
      expect(result.text).toContain("seed: no");
    } finally {
      await rmTempDir(root);
    }
  });

  test("invalid campaign exits as error", async () => {
    const root = await makeTempDir();
    try {
      const missing = path.join(root, "nope");
      await mkdir(missing, { recursive: true });
      let err: unknown;
      try {
        await showCampaign({ path: missing });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CampaignError);
    } finally {
      await rmTempDir(root);
    }
  });

  test("play_state load/save round-trip", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      await savePlayState(campaign, {
        success_turn_count: 7,
        luck_points: 5,
        luck_armed: false,
        last_hygiene_mode: "light",
        last_hygiene_status: "ok",
        last_hygiene_success_turn: 5,
        last_hygiene_transcript_line: 10,
        last_hygiene_at: "2026-08-07T12:00:00.000Z",
      });
      const loaded = await loadPlayState(campaign);
      expect(loaded.success_turn_count).toBe(7);
      expect(loaded.last_hygiene_mode).toBe("light");
      expect(loaded.last_hygiene_transcript_line).toBe(10);
      expect(loaded.luck_points).toBe(5);
      expect(loaded.luck_armed).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });
});
