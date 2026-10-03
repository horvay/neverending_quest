import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readCampaignMeta } from "../../src/campaign/open.ts";
import {
  birthLibraryCampaign,
  deleteLibraryCampaign,
  listLibraryCampaigns,
} from "../../src/home/library.ts";
import { makeTempDir, rmTempDir, writePack } from "../helpers/fs.ts";

describe("Home Campaign library", () => {
  test("births into the library dir and Continue lists by name", async () => {
    const root = await makeTempDir();
    try {
      const packs = path.join(root, "packs");
      const library = path.join(root, "campaigns");
      await writePack(path.join(packs, "brinewatch"), {
        "seed.md": "# Brinewatch\n\n## Opening message\n\nMira Venn watches you.\n",
        "player_sheet.md": "## Description\nRen Caldew.\n",
        "pack.yaml": "name: Brinewatch\n",
      });
      const born = await birthLibraryCampaign({
        packDir: path.join(packs, "brinewatch"),
        title: "Salt Lamp Nights",
        campaignsDir: library,
        id: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      });
      expect(born.meta.name).toBe("Salt Lamp Nights");
      expect(path.basename(born.path)).toBe("salt-lamp-nights-aaaaaaaa");
      expect((await readCampaignMeta(born.path)).name).toBe("Salt Lamp Nights");

      await mkdir(path.join(library, "not-a-campaign"), { recursive: true });
      const listed = await listLibraryCampaigns(library);
      expect(listed.map((c) => c.name)).toEqual(["Salt Lamp Nights"]);
      expect(listed[0]?.id).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      expect(listed[0]?.path).toBe(born.path);
    } finally {
      await rmTempDir(root);
    }
  });

  test("deletes only the selected Campaign folder from disk", async () => {
    const root = await makeTempDir();
    try {
      const packs = path.join(root, "packs");
      const library = path.join(root, "campaigns");
      const packDir = path.join(packs, "brinewatch");
      await writePack(packDir, {
        "seed.md": "# Brinewatch\n",
        "player_sheet.md": "## Description\nRen Caldew.\n",
        "pack.yaml": "name: Brinewatch\n",
      });
      const first = await birthLibraryCampaign({
        packDir,
        title: "Dock Nights",
        campaignsDir: library,
        id: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      });
      const second = await birthLibraryCampaign({
        packDir,
        title: "Bell Tower",
        campaignsDir: library,
        id: () => "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      });

      const deleted = await deleteLibraryCampaign(first.meta.id, library);

      expect(deleted?.name).toBe("Dock Nights");
      expect(await Bun.file(path.join(first.path, "campaign.yaml")).exists()).toBe(
        false,
      );
      expect((await listLibraryCampaigns(library)).map((c) => c.name)).toEqual([
        "Bell Tower",
      ]);
      expect(await deleteLibraryCampaign("missing", library)).toBeNull();
      expect(await Bun.file(path.join(second.path, "campaign.yaml")).exists()).toBe(
        true,
      );
    } finally {
      await rmTempDir(root);
    }
  });

});
