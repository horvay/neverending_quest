import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseDossierFrontmatter,
  stampAllDossierFrontmatter,
} from "../../src/campaign/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";

describe("dossier frontmatter stamp", () => {
  test("stampAllDossierFrontmatter writes files that lack a fence or personality", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        dossiers: {
          "plain.md": "# Plain\nNo fence.\n",
          "ok.md": "---\nname: Ok\naliases: []\nkind: person\n---\nKept.\n",
        },
      });
      const n = await stampAllDossierFrontmatter(campaign);
      expect(n).toBe(2);
      const plain = await readFile(
        path.join(campaign, "dossiers", "plain.md"),
        "utf8",
      );
      expect(parseDossierFrontmatter(plain).name).toBe("Plain");
      expect(parseDossierFrontmatter(plain).personality).toBe("");
      const ok = await readFile(path.join(campaign, "dossiers", "ok.md"), "utf8");
      expect(ok).toBe(
        '---\nname: Ok\naliases: []\nkind: person\nregard: 5\npersonality: ""\nappearance: ""\n---\nKept.\n',
      );
    } finally {
      await rmTempDir(root);
    }
  });

});
