import { describe, expect, test } from "bun:test";
import path from "node:path";
import { birthCampaign } from "../helpers/campaign.ts";
import { freePort, startCli, waitForListen } from "../helpers/cli.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster } from "../helpers/game_master.ts";

function isolated(root: string): Record<string, string> {
  return {
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
}

describe("bare play/serve open Home; path skips Home", () => {
  test("nq serve with no Campaign exposes /api/home and not a play stream", async () => {
    const root = await makeTempDir();
    const port = freePort();
    const running = startCli(["serve", "--port", String(port)], {
      env: isolated(root),
      factory: (await scriptedGameMaster()).factory,
    });
    try {
      const origin = `http://127.0.0.1:${port}`;
      await waitForListen(port, running);
      const home = await fetch(`${origin}/api/home`);
      expect(home.status).toBe(200);
      const snap = (await home.json()) as { open: unknown; packs: unknown[] };
      expect(snap.open).toBeNull();
      expect(Array.isArray(snap.packs)).toBe(true);
      const packs = (snap.packs as Array<{ id?: string; name?: string }>) ?? [];
      expect(
        packs.some((p) => p.id === "memory-gym" || p.name === "Memory Gym"),
      ).toBe(false);

      const events = await fetch(`${origin}/api/events`);
      expect(events.status).toBe(409);
    } finally {
      await running.stop();
      await rmTempDir(root);
    }
  });

  test("nq serve <path> skips Home and opens the book", async () => {
    const root = await makeTempDir();
    const port = freePort();
    const campaign = await birthCampaign(root, { name: "Brinewatch" });
    const gm = await scriptedGameMaster();
    const running = startCli(["serve", campaign, "--port", String(port)], {
      env: isolated(root),
      factory: gm.factory,
    });
    try {
      const origin = `http://127.0.0.1:${port}`;
      await waitForListen(port, running);
      const home = await fetch(`${origin}/api/home`);
      expect(home.status).toBe(200);
      const snap = (await home.json()) as { open: { name: string } | null };
      expect(snap.open?.name).toBe("Brinewatch");
      const events = await fetch(`${origin}/api/events`);
      expect(events.status).toBe(200);
      await events.body?.cancel();
    } finally {
      await running.stop();
      await rmTempDir(root);
    }
  });
});
