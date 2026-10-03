import { describe, expect, test } from "bun:test";
import { readTranscript } from "../../src/campaign/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { freePort, startCli, waitForListen } from "../helpers/cli.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster } from "../helpers/game_master.ts";

/** Wait until the Turn's git commit lands: the Play Loop's last busy step. */
async function waitForCommit(campaign: string, subject: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const log = await Bun.$`git -C ${campaign} log --format=%s`.quiet().nothrow();
    if (log.stdout.toString().split("\n").includes(subject)) return;
    await Bun.sleep(5);
  }
  throw new Error(`no "${subject}" commit`);
}

describe("nq serve CLI", () => {
  test("serves the book and plays a Turn through the real routes until stopped", async () => {
    const root = await makeTempDir();
    const port = freePort();
    const campaign = await birthCampaign(root, { name: "Brinewatch" });
    const gm = await scriptedGameMaster({
      steps: [(c) => c.say(`The lamps gutter as you ${c.prompt.toLowerCase()}.`)],
    });
    const running = startCli(["serve", campaign, "--port", String(port)], {
      factory: gm.factory,
    });
    try {
      const origin = `http://127.0.0.1:${port}`;
      await waitForListen(port, running);
      const page = await fetch(origin);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Neverending Quest");

      const posted = await fetch(`${origin}/api/turn`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ text: "Listen at the door" }),
      });
      expect(posted.status).toBe(202);
      await waitForCommit(campaign, "turn 1");

      expect(gm.calls.at(-1)?.prompt).toContain("Listen at the door");
      const rows = await readTranscript(campaign);
      expect(rows.at(-1)).toMatchObject({
        role: "gm",
        text: "The lamps gutter as you listen at the door.",
      });
      // still serving after a Turn: it only exits when stopped
      expect(running.exited()).toBe(false);
      const still = await fetch(origin);
      expect(still.status).toBe(200);
      await still.body?.cancel();
    } finally {
      const result = await running.stop();
      await rmTempDir(root);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`http://127.0.0.1:${port}/`);
    }
  });
});
