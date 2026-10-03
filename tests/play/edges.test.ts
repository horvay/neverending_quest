import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadPlayState, readTranscript } from "../../src/campaign/index.ts";
import { PlayLoop, type PlayEvent } from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster, says } from "../helpers/game_master.ts";

const SHEET_WITH_KEY =
  "## Description\nA weary ranger.\n\n## Inventory\n- bow\n- stolen key\n\n## Powers\n\n## Notes\n";

describe("Play Loop — control-plane edges", () => {
  test("empty/whitespace input becomes (continue)", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: says("Time passes.") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("   ");
      const rows = await readTranscript(campaign);
      expect(rows[0]?.text).toBe("(continue)");
      expect(gm.calls[0]?.prompt).toBe("(continue)");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("inactivity timeout → FAIL, no gm row", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      // the model never answers
      const gm = await scriptedGameMaster({
        steps: [(c) => c.aborted()],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { turnTimeoutMs: 20 },
      });
      await loop.open();
      const result = await loop.turn("wait");
      expect(result.outcome).toBe("fail");
      expect(result.reason).toBe("timeout");
      expect((await readTranscript(campaign)).map((r) => r.role)).toEqual([
        "player",
      ]);
      expect((await loadPlayState(campaign)).success_turn_count).toBe(0);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("continuous model activity extends the Turn timeout", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      // a slow model that keeps thinking: each gap is under the inactivity
      // timeout, but the whole reply takes well over it
      const gm = await scriptedGameMaster({
        steps: [
          async (c) => {
            for (let i = 0; i < 6; i++) {
              await Bun.sleep(30);
              if (c.signal?.aborted) return;
              c.think(".");
            }
            c.say("The thought resolves.");
          },
        ],
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { turnTimeoutMs: 150 },
      });
      await loop.open();
      const started = Date.now();
      const result = await loop.turn("Think this through");
      expect(Date.now() - started).toBeGreaterThan(150);
      expect(result.outcome).toBe("success");
      expect((await readTranscript(campaign)).at(-1)).toMatchObject({
        role: "gm",
        text: "The thought resolves.",
      });
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("interrupt mid-turn → FAIL reason interrupt", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const entered = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        steps: [
          async (c) => {
            entered.resolve();
            await c.aborted();
          },
        ],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const turnPromise = loop.turn("stop me");
      await entered.promise;
      loop.interrupt();
      const result = await turnPromise;
      expect(result.outcome).toBe("fail");
      expect(result.reason).toBe("interrupt");
      expect(gm.calls[0]?.signal?.aborted).toBe(true);
      expect((await loadPlayState(campaign)).success_turn_count).toBe(0);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("hard-busy rejects overlapping turn", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        steps: [
          async (c) => {
            entered.resolve();
            await gate.promise;
            c.say("done");
          },
        ],
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const first = loop.turn("one");
      await entered.promise;
      const busy = await loop.turn("two");
      expect(busy.outcome).toBe("fail");
      expect(busy.reason).toBe("busy");
      expect(
        events.some((e) => e.type === "error" && e.reason === "busy"),
      ).toBe(true);
      gate.resolve();
      const ok = await first;
      expect(ok.outcome).toBe("success");
      expect(
        (await readTranscript(campaign)).filter((r) => r.role === "player"),
      ).toHaveLength(1);
      // the rejected input never reached the model
      expect(gm.calls.map((c) => c.prompt)).toEqual(["one"]);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("play_state survives reopen", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("a");
      await loop.turn("b");
      await loop.close();

      const gm2 = await scriptedGameMaster({ fallback: says("ok") });
      const loop2 = new PlayLoop({ path: campaign, factory: gm2.factory });
      await loop2.open();
      expect(loop2.currentPlayState.success_turn_count).toBe(2);
      await loop2.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("FAIL keeps live memory writes and omits gm row", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const sheetPath = path.join(campaign, "player_sheet.md");
      // play Turns are read-only for the Game Master: its `write` is refused.
      // The sheet still changes on disk mid-Turn (the player's own editor),
      // then the provider fails the Turn; the FAIL must not roll that back.
      const gm = await scriptedGameMaster({
        steps: [
          (c) => c.tool("write", { path: "player_sheet.md", content: "wiped" }),
          async () => {
            await Bun.write(sheetPath, SHEET_WITH_KEY);
            throw new Error("provider hard fail");
          },
        ],
      });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const result = await loop.turn("grab the key");
      expect(result.outcome).toBe("fail");
      // the FAIL reason for a provider error is pinned by the failing test below
      expect(gm.calls[1]!.toolResults[0]?.text).toMatch(/write is not available now/);
      expect(await Bun.file(sheetPath).text()).toBe(SHEET_WITH_KEY);
      expect((await readTranscript(campaign)).map((r) => r.role)).toEqual([
        "player",
      ]);
      expect((await loadPlayState(campaign)).success_turn_count).toBe(0);
      // committed as the failed Turn
      const last = await Bun.$`git -C ${campaign} show --stat --format=%s HEAD`
        .quiet()
        .text();
      expect(last.split("\n")[0]).toBe("fail");
      expect(last).toContain("player_sheet.md");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  // KNOWN PRODUCT BUG: the OMP adapter's play prompt (src/agent/omp_factory.ts)
  // only reads `session.agent.state.error` for hidden prompts. A provider error
  // on a play Turn therefore comes back as empty prose: the Turn FAILs as
  // `empty_prose` and the player never sees the provider's message, so the
  // Play Loop's "Mid-Turn context overflow" branch is unreachable. With the
  // fix this test passes, and `test.failing` then flags it to be flipped back.
  test.failing("mid-Turn context overflow string → FAIL agent_error", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [
          () => {
            throw new Error("context overflow: prompt too long for maximum window");
          },
        ],
        fallback: says("unused"),
      });
      const events: PlayEvent[] = [];
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e) => events.push(e),
      });
      await loop.open();
      const result = await loop.turn("long");
      expect(result.outcome).toBe("fail");
      expect(result.reason).toBe("agent_error");
      expect(
        events.some(
          (e) =>
            e.type === "error" && e.message.includes("Mid-Turn context overflow"),
        ),
      ).toBe(true);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });
});
