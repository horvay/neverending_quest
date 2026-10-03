import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  archiveDossier,
  buildDossierCatalogMarkdown,
  CampaignError,
  createInspectDossier,
  listDossierCatalog,
  saveInspectFile,
  inspectHash,
  showCampaign,
} from "../../src/campaign/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, pathExists, readText, rmTempDir } from "../helpers/fs.ts";

describe("Dossier archive", () => {
  test("moves a live dossier to dossiers/archive and back", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        dossiers: {
          pell:
            "---\nname: Pell\naliases: []\nkind: person\n---\nA locksmith.\n",
        },
      });
      const first = await archiveDossier(campaign, "pell", true);
      expect(first.moved).toBe(true);
      expect(first.archived).toBe(true);
      expect(first.to).toBe("dossiers/archive/pell.md");
      expect(await pathExists(campaign, "dossiers/pell.md")).toBe(false);
      expect(
        await readText(campaign, "dossiers/archive/pell.md"),
      ).toContain("locksmith");

      const again = await archiveDossier(campaign, "pell", true);
      expect(again.moved).toBe(false);

      const back = await archiveDossier(campaign, "pell", false);
      expect(back.moved).toBe(true);
      expect(back.archived).toBe(false);
      expect(await pathExists(campaign, first.to)).toBe(false);
      expect(await readText(campaign, "dossiers/pell.md")).toContain(
        "locksmith",
      );
    } finally {
      await rmTempDir(root);
    }
  });

  test("catalog pin omits archived dossiers; list still includes them", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        dossiers: {
          pell:
            "---\nname: Pell\naliases: []\nkind: person\n---\nA locksmith.\n",
          mira:
            "---\nname: Mira\naliases: []\nkind: person\n---\nInnkeeper.\n",
        },
      });
      await archiveDossier(campaign, "pell", true);
      const pin = await buildDossierCatalogMarkdown(campaign);
      expect(pin).toContain('<file path="dossiers/mira.md:1-5">');
      expect(pin).not.toContain("dossiers/pell.md");
      const listed = await listDossierCatalog(campaign, { includeBody: true });
      expect(listed.map((e) => e.slug).sort()).toEqual(["mira", "pell"]);
      expect(listed.find((e) => e.slug === "pell")?.archived).toBe(true);
      expect(listed.find((e) => e.slug === "mira")?.archived).toBeUndefined();
    } finally {
      await rmTempDir(root);
    }
  });

  test("refuses a missing slug and a colliding live/archive pair", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        dossiers: {
          pell:
            "---\nname: Pell\naliases: []\nkind: person\n---\nA locksmith.\n",
        },
      });
      let missing: unknown;
      try {
        await archiveDossier(campaign, "nope", true);
      } catch (err) {
        missing = err;
      }
      expect(missing).toBeInstanceOf(CampaignError);
      expect((missing as CampaignError).code).toBe("dossier_missing");

      await mkdir(path.join(campaign, "dossiers", "archive"), {
        recursive: true,
      });
      await writeFile(
        path.join(campaign, "dossiers", "archive", "pell.md"),
        "---\nname: Pell\n---\nGhost.\n",
      );
      let clash: unknown;
      try {
        await archiveDossier(campaign, "pell", true);
      } catch (err) {
        clash = err;
      }
      expect(clash).toBeInstanceOf(CampaignError);
      expect((clash as CampaignError).code).toBe("dossier_exists");
    } finally {
      await rmTempDir(root);
    }
  });

  test("create refuses a slug that only exists in archive; show and save still find it", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        dossiers: {
          pell:
            "---\nname: Pell\naliases: []\nkind: person\n---\nA locksmith.\n",
        },
      });
      await archiveDossier(campaign, "pell", true);
      let exists: unknown;
      try {
        await createInspectDossier({ path: campaign, slug: "pell" });
      } catch (err) {
        exists = err;
      }
      expect(exists).toBeInstanceOf(CampaignError);
      expect((exists as CampaignError).code).toBe("dossier_exists");

      const shown = await showCampaign({
        path: campaign,
        target: "dossiers",
        dossierSlug: "pell",
      });
      expect(shown.target).toBe("dossiers");
      if (shown.target === "dossiers") {
        expect(shown.archived).toBe(true);
        expect(shown.text).toContain("locksmith");
      }

      const saved = await saveInspectFile({
        path: campaign,
        target: "dossiers",
        slug: "pell",
        body:
          "---\nname: Pell\naliases: []\nkind: person\n---\nStill the locksmith.\n",
        hash: inspectHash(shown.text),
      });
      expect(saved.text).toContain("Still the locksmith");
      expect(
        await readText(campaign, "dossiers/archive/pell.md"),
      ).toContain("Still the locksmith");
    } finally {
      await rmTempDir(root);
    }
  });
});
