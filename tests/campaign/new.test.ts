import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  newCampaign,
  CampaignError,
  PLAYER_SHEET_H2S,
  type CampaignMeta,
} from "../../src/campaign/index.ts";
import {
  listRel,
  makeTempDir,
  pathExists,
  readText,
  readYaml,
  rmTempDir,
  writePack,
} from "../helpers/fs.ts";

const FIXED_NOW = new Date("2026-08-07T12:00:00.000Z");
const FIXED_ID = "11111111-2222-4333-8444-555555555555";

describe("nq new — Campaign birth", () => {
  test("materializes full skeleton from minimal Seed Pack", async () => {
    const root = await makeTempDir();
    try {
      const pack = path.join(root, "pack");
      const campaign = path.join(root, "my-quest");
      await writePack(pack, {
        "seed.md": "# Premise\nYou are the GM of a haunted marsh.\n",
        "player_sheet.md":
          "## Description\nA weary ranger.\n\n## Inventory\n- bow\n\n## Powers\n\n## Notes\n",
      });

      const meta = await newCampaign({
        path: campaign,
        packDir: pack,
        now: () => FIXED_NOW,
        id: () => FIXED_ID,
      });

      expect(meta).toEqual({
        id: FIXED_ID,
        created_at: "2026-08-07T12:00:00.000Z",
        schema_version: 1,
        name: "my-quest",
      });

      const yaml = await readYaml<CampaignMeta>(campaign, "campaign.yaml");
      expect(yaml).toEqual(meta);

      expect(await readText(campaign, "seed.md")).toBe(
        "# Premise\nYou are the GM of a haunted marsh.\n",
      );
      expect(await pathExists(campaign, "player_sheet.md")).toBe(true);
      expect(await pathExists(campaign, "world-building.md")).toBe(true);
      expect(await readText(campaign, "world-building.md")).toBe("");
      expect(await pathExists(campaign, "dossiers")).toBe(true);
      expect(await readText(campaign, "story-beats.md")).toBe("");
      expect(await readText(campaign, "quest-log.md")).toBe("");
      expect(await readText(campaign, "transcript.jsonl")).toBe("");
      expect(await pathExists(campaign, ".nq/sessions")).toBe(true);

      // play_state may be lazy — must not be required at birth
      const files = await listRel(campaign);
      expect(files).not.toContain(".nq/play_state.json");
      expect(files.some((f) => f.startsWith("dossiers/"))).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("uses --name when set, else path basename", async () => {
    const root = await makeTempDir();
    try {
      const pack = path.join(root, "pack");
      await writePack(pack, {
        "seed.md": "seed\n",
        "player_sheet.md": sheetWithAllH2s(),
      });

      const named = path.join(root, "folder-name");
      const metaNamed = await newCampaign({
        path: named,
        packDir: pack,
        name: "Display Name",
        now: () => FIXED_NOW,
        id: () => FIXED_ID,
      });
      expect(metaNamed.name).toBe("Display Name");

      const defaulted = path.join(root, "from-basename");
      const metaDefault = await newCampaign({
        path: defaulted,
        packDir: pack,
        now: () => FIXED_NOW,
        id: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      });
      expect(metaDefault.name).toBe("from-basename");
    } finally {
      await rmTempDir(root);
    }
  });

  test("copies optional world-building and dossiers; ignores pack.yaml and unknown files", async () => {
    const root = await makeTempDir();
    try {
      const pack = path.join(root, "pack");
      const campaign = path.join(root, "rich");
      await writePack(pack, {
        "seed.md": "seed\n",
        "player_sheet.md": sheetWithAllH2s(),
        "world-building.md": "## Factions\nThe Ash Court.\n",
        "dossiers/mira.md": "---\nname: Mira\nkind: person\n---\nA guide.\n",
        "dossiers/old-mill.md": "---\nname: Old Mill\nkind: place\n---\nRuins.\n",
        "pack.yaml": "author: someone\n",
        "README.md": "not copied\n",
        "notes.txt": "ignored\n",
      });

      await newCampaign({
        path: campaign,
        packDir: pack,
        now: () => FIXED_NOW,
        id: () => FIXED_ID,
      });

      expect(await readText(campaign, "world-building.md")).toBe(
        "## Factions\nThe Ash Court.\n",
      );
      expect(await readText(campaign, "dossiers/mira.md")).toContain("A guide.");
      expect(await readText(campaign, "dossiers/old-mill.md")).toContain("Ruins.");
      expect(await pathExists(campaign, "pack.yaml")).toBe(false);
      expect(await pathExists(campaign, "README.md")).toBe(false);
      expect(await pathExists(campaign, "notes.txt")).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("appends missing Player Sheet H2s without destroying existing body", async () => {
    const root = await makeTempDir();
    try {
      const pack = path.join(root, "pack");
      const campaign = path.join(root, "sheet-fix");
      await writePack(pack, {
        "seed.md": "seed\n",
        "player_sheet.md": "## Description\nOnly description so far.\n",
      });

      await newCampaign({
        path: campaign,
        packDir: pack,
        now: () => FIXED_NOW,
        id: () => FIXED_ID,
      });

      const sheet = await readText(campaign, "player_sheet.md");
      expect(sheet).toContain("## Description\nOnly description so far.");
      for (const h2 of PLAYER_SHEET_H2S) {
        expect(sheet).toMatch(new RegExp(`^## ${h2}\\s*$`, "m"));
      }
      // Description body preserved; other H2s appended
      const descIdx = sheet.indexOf("## Description");
      const invIdx = sheet.indexOf("## Inventory");
      expect(descIdx).toBeGreaterThanOrEqual(0);
      expect(invIdx).toBeGreaterThan(descIdx);
    } finally {
      await rmTempDir(root);
    }
  });

  test("fails clearly when pack lacks seed.md or player_sheet.md without half Campaign", async () => {
    const root = await makeTempDir();
    try {
      const packNoSeed = path.join(root, "pack-no-seed");
      await writePack(packNoSeed, {
        "player_sheet.md": sheetWithAllH2s(),
      });
      const target1 = path.join(root, "c1");
      await expectRejected(
        () => newCampaign({ path: target1, packDir: packNoSeed }),
        "seed.md",
      );
      expect(await pathExists(root, "c1")).toBe(false);

      const packNoSheet = path.join(root, "pack-no-sheet");
      await writePack(packNoSheet, { "seed.md": "seed\n" });
      const target2 = path.join(root, "c2");
      await expectRejected(
        () => newCampaign({ path: target2, packDir: packNoSheet }),
        "player_sheet.md",
      );
      expect(await pathExists(root, "c2")).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("fails if target exists and is non-empty; empty dir is OK", async () => {
    const root = await makeTempDir();
    try {
      const pack = path.join(root, "pack");
      await writePack(pack, {
        "seed.md": "seed\n",
        "player_sheet.md": sheetWithAllH2s(),
      });

      const nonempty = path.join(root, "taken");
      await mkdir(nonempty, { recursive: true });
      await writeFile(path.join(nonempty, "keep.txt"), "nope\n");
      await expectRejected(
        () => newCampaign({ path: nonempty, packDir: pack }),
        "not empty",
      );
      expect(await readText(nonempty, "keep.txt")).toBe("nope\n");

      const empty = path.join(root, "empty-ok");
      await mkdir(empty, { recursive: true });
      const meta = await newCampaign({
        path: empty,
        packDir: pack,
        now: () => FIXED_NOW,
        id: () => FIXED_ID,
      });
      expect(meta.name).toBe("empty-ok");
      expect(await pathExists(empty, "campaign.yaml")).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });
});

function sheetWithAllH2s(): string {
  return "## Description\n\n## Inventory\n\n## Powers\n\n## Notes\n";
}

async function expectRejected(
  fn: () => Promise<unknown>,
  messagePart: string,
): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(CampaignError);
  expect((err as Error).message.toLowerCase()).toContain(messagePart.toLowerCase());
}
