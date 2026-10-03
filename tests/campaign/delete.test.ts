import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  deleteCampaign,
  readCampaignMeta,
} from "../../src/campaign/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("deleteCampaign", () => {
  test("removes the Campaign folder only after confirm returns true", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { name: "doomed" });
      const meta = await readCampaignMeta(campaign);
      const seen: Array<{ path: string; name: string }> = [];

      const declined = await deleteCampaign({
        path: campaign,
        confirm: async (info) => {
          seen.push({ path: info.path, name: info.meta.name });
          return false;
        },
      });
      expect(declined.deleted).toBe(false);
      expect(await exists(campaign)).toBe(true);
      expect(seen[0]?.name).toBe(meta.name);

      const accepted = await deleteCampaign({
        path: campaign,
        confirm: () => true,
      });
      expect(accepted.deleted).toBe(true);
      expect(accepted.meta.id).toBe(meta.id);
      expect(await exists(campaign)).toBe(false);
      expect(await exists(path.dirname(campaign))).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });

  test("refuses a path that is not a Campaign", async () => {
    const root = await makeTempDir();
    try {
      const plain = path.join(root, "plain");
      await Bun.write(path.join(plain, "notes.txt"), "nope\n");
      await expect(
        deleteCampaign({ path: plain, confirm: () => true }),
      ).rejects.toMatchObject({ code: "not_a_campaign" });
      expect(await exists(path.join(plain, "notes.txt"))).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });
});
