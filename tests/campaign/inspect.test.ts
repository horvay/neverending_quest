import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CampaignError,
  createInspectDossier,
  inspectHash,
  PLAYER_SHEET_MD,
  saveInspectFile,
  SEED_MD,
} from "../../src/campaign/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, pathExists, rmTempDir } from "../helpers/fs.ts";

describe("Inspect write (disk)", () => {
  test("saveInspectFile writes the raw body when the hash matches", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        sheet: "## Description\nRen Caldew\n",
      });
      const current = await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8");
      const next = "## Description\n**Ren Caldew** — dock runner.\n";
      const saved = await saveInspectFile({
        path: campaign,
        target: "sheet",
        body: next,
        hash: inspectHash(current),
      });
      expect(saved.text).toBe(next);
      expect(saved.hash).toBe(inspectHash(next));
      expect(await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8")).toBe(
        next,
      );
    } finally {
      await rmTempDir(root);
    }
  });

  test("saveInspectFile is stale when the disk file changed", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        sheet: "## Description\nRen Caldew\n",
      });
      const loaded = await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8");
      const disk = "## Description\nRen, rewritten on disk.\n";
      await writeFile(path.join(campaign, PLAYER_SHEET_MD), disk);
      let err: unknown;
      try {
        await saveInspectFile({
          path: campaign,
          target: "sheet",
          body: "## Description\nplayer edit\n",
          hash: inspectHash(loaded),
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("stale");
      expect((err as CampaignError).diskText).toBe(disk);
      expect((err as CampaignError).diskHash).toBe(inspectHash(disk));
      expect(await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8")).toBe(
        disk,
      );
    } finally {
      await rmTempDir(root);
    }
  });

  test("createInspectDossier writes a new slug and refuses a second create", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const created = await createInspectDossier({
        path: campaign,
        slug: "kell-brine",
        body: "---\nname: Kell Brine\n---\nFerry hand.\n",
      });
      expect(created.slug).toBe("kell-brine");
      expect(created.text.startsWith("---\n")).toBe(true);
      expect(created.text).toContain("kind: other");
      expect(created.text).toContain('personality: ""');
      expect(created.text).toContain('appearance: ""');
      expect(created.text).toContain("Ferry hand.");
      expect(
        await readFile(path.join(campaign, "dossiers", "kell-brine.md"), "utf8"),
      ).toContain("Ferry hand.");

      let err: unknown;
      try {
        await createInspectDossier({
          path: campaign,
          slug: "kell-brine",
          body: "other",
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("dossier_exists");
    } finally {
      await rmTempDir(root);
    }
  });

  test("createInspectDossier scaffolds exact optional sections by kind", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const person = await createInspectDossier({
        path: campaign,
        slug: "mira-venn",
        body: "---\nname: Mira Venn\naliases: []\nkind: person\n---\n",
      });
      const place = await createInspectDossier({
        path: campaign,
        slug: "salt-lamp",
        body: "---\nname: Salt Lamp\naliases: []\nkind: place\n---\n",
      });
      const other = await createInspectDossier({
        path: campaign,
        slug: "tide-key",
        body: "---\nname: Tide Key\naliases: []\nkind: other\n---\n",
      });

      expect(person.text.match(/^## .+$/gm)).toEqual([
        "## Inventory",
        "## Relationships",
        "## Abilities",
        "## Quirks",
      ]);
      expect(place.text.match(/^## .+$/gm)).toEqual([
        "## Relationships",
        "## Abilities",
        "## Quirks",
        "## Establishment",
      ]);
      expect(other.text.match(/^## .+$/gm)).toEqual([
        "## Relationships",
        "## Abilities",
        "## Quirks",
      ]);
    } finally {
      await rmTempDir(root);
    }
  });

  test("createInspectDossier rejects a bad slug", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      let err: unknown;
      try {
        await createInspectDossier({ path: campaign, slug: "Kell Brine" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("dossier_slug_invalid");
      expect(await pathExists(campaign, "dossiers/Kell Brine.md")).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("saveInspectFile refuses status and transcript", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Brinewatch\n\nMira keeps the Salt Lamp.\n",
      });
      const seed = await readFile(path.join(campaign, SEED_MD), "utf8");
      for (const target of ["status", "transcript"]) {
        let err: unknown;
        try {
          await saveInspectFile({
            path: campaign,
            target,
            body: "nope",
            hash: inspectHash(""),
          });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(CampaignError);
        expect((err as CampaignError).code).toBe("inspect_forbidden");
      }
      expect(await readFile(path.join(campaign, SEED_MD), "utf8")).toBe(seed);
    } finally {
      await rmTempDir(root);
    }
  });
});
