import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  ensureOpeningTranscript,
  listCampaignHistory,
} from "../../src/campaign/index.ts";
import { PlayLoop, type PlayEvent } from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import {
  scriptedGameMaster,
  says,
  type ModelCall,
} from "../helpers/game_master.ts";

/** Memory Hygiene is a hidden pass: OMP sends it as a developer message. */
function isHygiene(call: ModelCall): boolean {
  return call.instruction.startsWith("[Memory Hygiene");
}

/** Nothing left uncommitted in the Campaign's working tree. */
async function worktreeClean(campaign: string): Promise<boolean> {
  const out = await Bun.$`git -C ${campaign} status --porcelain`.quiet().text();
  return out.trim() === "";
}

const SEED_WITH_OPENING = `# Voice

Speak sparsely.

## Opening message

Dust lifts off the arena stones.

Kel watches the gate.

## Memory

Keep files current.
`;

describe("Play Loop — commit policy", () => {
  test("SUCCESS adds one history commit per turn after the busy window", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const before = await listCampaignHistory(campaign);
      const gm = await scriptedGameMaster({
        fallback: says("Fog parts. A path appears."),
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      expect(await listCampaignHistory(campaign)).toHaveLength(before.length);

      const first = await loop.turn("I step forward");
      expect(first.outcome).toBe("success");
      const afterOne = await listCampaignHistory(campaign);
      expect(afterOne).toHaveLength(before.length + 1);
      expect(afterOne[0]?.oid).not.toBe(before[0]?.oid);
      expect(afterOne[0]?.message).toBe("turn 1");

      const second = await loop.turn("I keep walking");
      expect(second.outcome).toBe("success");
      const afterTwo = await listCampaignHistory(campaign);
      expect(afterTwo).toHaveLength(before.length + 2);
      expect(afterTwo[0]?.oid).not.toBe(afterOne[0]?.oid);
      expect(afterTwo[0]?.message).toBe("turn 2");
      expect(await worktreeClean(campaign)).toBe(true);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("FAIL commits fail after the player row", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      // the model answers with whitespace only, even through OMP's nudges
      const gm = await scriptedGameMaster({ fallback: says("   ") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const before = await listCampaignHistory(campaign);

      const result = await loop.turn("hello");
      expect(result.outcome).toBe("fail");
      expect(result.reason).toBe("empty_prose");
      const after = await listCampaignHistory(campaign);
      expect(after).toHaveLength(before.length + 1);
      expect(after[0]?.message).toBe("fail");
      expect(after[0]?.oid).not.toBe(before[0]?.oid);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("SUCCESS that triggers light hygiene is one commit not two", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: (c) => {
          if (!isHygiene(c)) return c.say("story");
          // the hidden pass writes memory through the real write tool
          if (c.toolResults.length === 0) {
            return c.tool("write", {
              path: "story-beats.md",
              content: "- ranger entered marsh\n",
            });
          }
          c.say("hygiene internal summary — discard me");
        },
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 1 },
      });
      await loop.open();
      const before = await listCampaignHistory(campaign);

      const result = await loop.turn("go");
      expect(result.outcome).toBe("success");
      expect(result.playState.last_hygiene_status).toBe("ok");
      expect(gm.calls.some(isHygiene)).toBe(true);
      expect(
        await Bun.file(path.join(campaign, "story-beats.md")).text(),
      ).toBe("- ranger entered marsh\n");

      const after = await listCampaignHistory(campaign);
      expect(after).toHaveLength(before.length + 1);
      expect(after[0]?.message).toBe("turn 1");
      // the hygiene write rode in the turn commit
      expect(await worktreeClean(campaign)).toBe(true);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("SUCCESS that triggers compact is one commit not two", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: (c) => {
          if (!isHygiene(c)) {
            // the provider reports a prompt over the rebuild ceiling
            c.usage({ input: 130_000 });
            return c.say("Beat for: go");
          }
          if (c.toolResults.length === 0) {
            return c.tool("write", {
              path: "story-beats.md",
              content: "- compacted beat\n",
            });
          }
          c.say("heavy ok");
        },
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: {
          hygieneN: 10,
          compactCeilingTokens: 128_000,
        },
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const before = await listCampaignHistory(campaign);

      const result = await loop.turn("go");
      expect(result.outcome).toBe("success");
      expect(events.some((e) => e.type === "compact_ended" && e.ok)).toBe(true);
      expect(
        gm.calls.some((c) =>
          c.instruction.startsWith("[Memory Hygiene — heavy"),
        ),
      ).toBe(true);
      expect(
        await Bun.file(path.join(campaign, "story-beats.md")).text(),
      ).toBe("- compacted beat\n");

      const after = await listCampaignHistory(campaign);
      expect(after).toHaveLength(before.length + 1);
      expect(after[0]?.message).toBe("turn 1");
      expect(await worktreeClean(campaign)).toBe(true);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("interrupt FAIL commits fail", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      let loopRef: PlayLoop | undefined;
      const entered = Promise.withResolvers<void>();
      // the model thinks until the player presses Stop, having said nothing
      const gm = await scriptedGameMaster({
        steps: [
          async (c) => {
            c.think("Weighing it.");
            entered.resolve();
            await c.aborted();
          },
        ],
      });
      loopRef = new PlayLoop({ path: campaign, factory: gm.factory });
      await loopRef.open();
      const before = await listCampaignHistory(campaign);
      const turnPromise = loopRef.turn("stop me");
      await entered.promise;
      loopRef.interrupt();
      const result = await turnPromise;
      expect(result.outcome).toBe("fail");
      expect(result.reason).toBe("interrupt");
      const after = await listCampaignHistory(campaign);
      expect(after).toHaveLength(before.length + 1);
      expect(after[0]?.message).toBe("fail");
      await loopRef.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("git failure after SUCCESS still returns Idle and does not fail the Turn", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const events: PlayEvent[] = [];
      const gm = await scriptedGameMaster({ fallback: says("Fog parts.") });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      await rm(path.join(campaign, ".git"), { recursive: true, force: true });

      const result = await loop.turn("I step forward");
      expect(result.outcome).toBe("success");
      expect(loop.loopState).toBe("idle");
      expect(
        events.some((e) => e.type === "error" && e.reason === "git_failed"),
      ).toBe(true);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("opening copy commits opening; no extra commit without an opening", async () => {
    const withOpening = await makeTempDir();
    const withoutOpening = await makeTempDir();
    try {
      const opened = await birthCampaign(withOpening, {
        seed: SEED_WITH_OPENING,
      });
      const beforeOpen = await listCampaignHistory(opened);
      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({ path: opened, factory: gm.factory });
      await loop.open();
      const afterOpen = await listCampaignHistory(opened);
      expect(afterOpen).toHaveLength(beforeOpen.length + 1);
      expect(afterOpen[0]?.message).toBe("opening");
      await loop.close();

      const bare = await birthCampaign(withoutOpening, {
        seed: "# Seed\nNo opener heading.\n",
      });
      const beforeBare = await listCampaignHistory(bare);
      const loop2 = new PlayLoop({
        path: bare,
        factory: gm.factory,
      });
      await loop2.open();
      expect(await listCampaignHistory(bare)).toHaveLength(beforeBare.length);
      await loop2.close();
      // opening is copied from the seed, never asked of the model
      expect(gm.calls).toHaveLength(0);
    } finally {
      await rmTempDir(withOpening);
      await rmTempDir(withoutOpening);
    }
  });

  test("reopen after opening commit does not add another opening", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { seed: SEED_WITH_OPENING });
      const before = await listCampaignHistory(campaign);
      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
      });
      await loop.open();
      await loop.close();

      const loop2 = new PlayLoop({
        path: campaign,
        factory: gm.factory,
      });
      await loop2.open();
      const after = await listCampaignHistory(campaign);
      expect(after).toHaveLength(before.length + 1);
      expect(after.filter((c) => c.message === "opening")).toHaveLength(1);
      await loop2.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("ensureOpeningTranscript then open is at most one opening commit", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { seed: SEED_WITH_OPENING });
      const seeded = await ensureOpeningTranscript(campaign);
      expect(seeded.seeded).toBe(true);

      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
      });
      await loop.open();
      const openingCommits = (await listCampaignHistory(campaign)).filter(
        (c) => c.message === "opening",
      );
      expect(openingCommits.length).toBeLessThanOrEqual(1);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
