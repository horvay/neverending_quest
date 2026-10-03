import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { birthCampaign } from "../helpers/campaign.ts";
import { runCli } from "../helpers/cli.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function runNq(args: string[]) {
  return runCli(args);
}

describe("nq delete CLI", () => {
  test("--yes permanently removes a Campaign folder", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { name: "gone-camp" });
      expect(await exists(campaign)).toBe(true);
      const { code, stdout } = await runNq(["delete", campaign, "--yes"]);
      expect(code).toBe(0);
      expect(stdout).toContain('Deleted Campaign "gone-camp"');
      expect(await exists(campaign)).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("refuses non-TTY delete without --yes and keeps the folder", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { name: "keep-camp" });
      const { code, stderr } = await runNq(["delete", campaign]);
      expect(code).toBe(1);
      expect(stderr).toContain("Refusing to delete without confirmation");
      expect(await exists(campaign)).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });

  test("rm alias works with -y", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { name: "alias-camp" });
      const { code } = await runNq(["rm", campaign, "-y"]);
      expect(code).toBe(0);
      expect(await exists(campaign)).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("rejects a path that is not a Campaign", async () => {
    const root = await makeTempDir();
    try {
      const plain = path.join(root, "notes-dir");
      await Bun.write(path.join(plain, "x.txt"), "hi\n");
      const { code, stderr } = await runNq(["delete", plain, "--yes"]);
      expect(code).toBe(1);
      expect(stderr).toMatch(/Not a Campaign|missing campaign\.yaml/i);
      expect(await exists(path.join(plain, "x.txt"))).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });
});
