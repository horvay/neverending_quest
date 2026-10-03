import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { writeTerminalBreadcrumb } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { readTranscript } from "../../src/campaign/index.ts";
import { PlayLoop } from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster, type ModelCall } from "../helpers/game_master.ts";

/** Echo the player, so each reply names the Turn it answered. */
function echo(call: ModelCall): void {
  call.say(
    call.instruction.startsWith("[Memory Hygiene")
      ? "Memory kept."
      : `reply to ${call.prompt}`,
  );
}

function history(call: ModelCall | undefined): string {
  return JSON.stringify(call?.context.messages ?? []);
}

async function journals(campaign: string): Promise<string[]> {
  const dir = path.join(campaign, ".nq", "sessions");
  // file names lead with their creation time
  return (await readdir(dir))
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(dir, name));
}

describe("Play Loop — resume after restart", () => {
  test("a stale terminal breadcrumb cannot resume a journal from before an edit", async () => {
    const root = await makeTempDir();
    const pane = process.env.TMUX_PANE;
    // OMP keys breadcrumbs by terminal; give a non-TTY run one to key on
    process.env.TMUX_PANE = "%nq-resume-test";
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: echo });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("a");
      await loop.turn("b");
      const [beforeEdit] = await journals(campaign);

      const replyB = (await readTranscript(campaign)).at(-1)!;
      await loop.editTranscript(replyB.ts, "EDITED b");
      await loop.turn("c");
      await loop.turn("d");
      await loop.close();

      // yesterday's `nq serve` in this terminal played the pre-edit journal
      writeTerminalBreadcrumb(campaign, beforeEdit!);

      const gm2 = await scriptedGameMaster({ fallback: echo });
      const loop2 = new PlayLoop({ path: campaign, factory: gm2.factory });
      await loop2.open();
      expect(loop2.hasPrimedSession).toBe(false);
      await loop2.turn("e");
      await loop2.close();

      const request = history(gm2.calls[0]);
      expect(request).toContain("EDITED b");
      expect(request).toContain("reply to c");
      expect(request).toContain("reply to d");
      expect(request).not.toContain("reply to b");

      const story = await readTranscript(campaign);
      expect(story.map((row) => row.text).slice(-7)).toEqual([
        "EDITED b",
        "c",
        "reply to c",
        "d",
        "reply to d",
        "e",
        "reply to e",
      ]);
    } finally {
      if (pane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = pane;
      await rmTempDir(root);
    }
  });

  test("a journal kept in sync through Memory Hygiene resumes after restart", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: echo });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 1 },
      });
      await loop.open();
      await loop.turn("a");
      expect(
        gm.calls.some((call) => call.instruction.startsWith("[Memory Hygiene")),
      ).toBe(true);
      await loop.close();

      const gm2 = await scriptedGameMaster({ fallback: echo });
      const loop2 = new PlayLoop({ path: campaign, factory: gm2.factory });
      await loop2.open();
      expect(loop2.hasPrimedSession).toBe(false);
      await loop2.turn("b");
      await loop2.close();

      const request = history(gm2.calls[0]);
      expect(request).toContain("reply to a");
      expect(request).not.toContain("Memory Hygiene");
      expect(request).not.toContain("Memory kept.");
    } finally {
      await rmTempDir(root);
    }
  });
});
