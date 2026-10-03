import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultPacksDir, listSeedPacks } from "../../src/home/packs.ts";
import { makeTempDir, rmTempDir, writePack } from "../helpers/fs.ts";

describe("Home Seed Pack scan", () => {
  test("lists only valid dirs, using pack.yaml name + description", async () => {
    const root = await makeTempDir();
    try {
      await writePack(path.join(root, "brinewatch"), {
        "seed.md": "# Brinewatch\n",
        "player_sheet.md": "## Description\nRen.\n",
        "pack.yaml": "name: Brinewatch\ndescription: Salt dock sandbox.\n",
      });
      await writePack(path.join(root, "untitled-marsh"), {
        "seed.md": "# Marsh\n",
        "player_sheet.md": "## Description\nA ranger.\n",
      });
      await mkdir(path.join(root, "empty-dir"), { recursive: true });
      await writeFile(path.join(root, "notes.md"), "not a pack\n");
      await writePack(path.join(root, "incomplete"), {
        "seed.md": "# No sheet\n",
      });

      const cards = await listSeedPacks(root);
      expect(cards.map((c) => c.name)).toEqual(["Brinewatch", "Untitled Marsh"]);
      expect(cards[0]?.description).toBe("Salt dock sandbox.");
      expect(cards.some((c) => c.id === "incomplete")).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("broken pack.yaml still lists the pack by folder name", async () => {
    const root = await makeTempDir();
    try {
      await writePack(path.join(root, "salt-dock"), {
        "seed.md": "# Brinewatch\n",
        "player_sheet.md": "## Description\nRen.\n",
        "pack.yaml": "name: [this is not: valid yaml :::\n",
      });
      const cards = await listSeedPacks(root);
      expect(cards).toEqual([
        {
          id: "salt-dock",
          dir: path.join(root, "salt-dock"),
          name: "Salt Dock",
          description: undefined,
        },
      ]);
    } finally {
      await rmTempDir(root);
    }
  });

  test("memory-gym is not under player packs/", async () => {
    const packs = defaultPacksDir();
    expect(packs.endsWith(`${path.sep}packs`)).toBe(true);
    const cards = await listSeedPacks(packs);
    expect(cards.some((c) => c.id === "memory-gym")).toBe(false);
    expect(cards.some((c) => /memory gym/i.test(c.name))).toBe(false);
    const gymOnDisk = Bun.file(path.join(packs, "memory-gym", "seed.md"));
    expect(await gymOnDisk.exists()).toBe(false);
  });
});
