import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { Chunk, Effect, Stream } from "effect";
import { readTranscript } from "../../src/campaign/index.ts";
import { SEED_MD } from "../../src/campaign/paths.ts";
import {
  applyPlayEvent,
  createKernel,
  type PlayEvent,
} from "../../src/play/index.ts";
import {
  PlayOpenError,
  playSessionLayer,
  withPlaySession,
  type PlaySessionApi,
} from "../../src/play/session.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster, says } from "../helpers/game_master.ts";

/**
 * Subscribe to the session's event stream, then run `act`, then read events
 * until `until` matches. Subscribing first (instead of forking a collector and
 * sleeping) means no event of the Turn can be missed.
 */
function eventsDuring(
  s: PlaySessionApi,
  act: Effect.Effect<void>,
  until: (e: PlayEvent) => boolean,
) {
  return Effect.gen(function* () {
    const pull = yield* Stream.toPull(s.events);
    yield* act;
    const seen: PlayEvent[] = [];
    while (!seen.some(until)) {
      seen.push(...Chunk.toArray(yield* pull.pipe(Effect.orDie)));
    }
    return seen;
  });
}

/** The Play Loop is Idle again only after its final commit. */
function untilIdle(s: PlaySessionApi) {
  return Effect.gen(function* () {
    while (yield* s.isBusy) yield* Effect.sleep("1 millis");
  });
}

describe("PlaySession adapter", () => {
  test("open fails when seed.md is missing", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Brinewatch\n\nMira Venn keeps the Salt Lamp.\n",
      });
      await unlink(path.join(campaign, SEED_MD));
      const gm = await scriptedGameMaster();
      const layer = playSessionLayer({ path: campaign, factory: gm.factory });
      const prog = withPlaySession(Effect.void).pipe(
        Effect.provide(layer),
        Effect.scoped,
      );
      const exit = await Effect.runPromise(Effect.either(prog));
      expect(exit._tag).toBe("Left");
      if (exit._tag === "Left") {
        expect(exit.left).toBeInstanceOf(PlayOpenError);
      }
      expect(gm.calls).toHaveLength(0);
    } finally {
      await rmTempDir(root);
    }
  });

  test("submit streams turn events and kernel can fold Mira's reply", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Brinewatch\n\n## Opening message\n\nMira Venn watches you from the Salt Lamp doorway.\n",
      });
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.say("Mira looks at your hands, ");
            c.say("not your face.");
          },
        ],
      });
      const layer = playSessionLayer({ path: campaign, factory: gm.factory });
      const prog = withPlaySession((s) =>
        Effect.gen(function* () {
          const events = yield* eventsDuring(
            s,
            s.submit("I nod to Mira."),
            (e) => e.type === "turn_ended",
          );
          yield* untilIdle(s);
          return { events, snap: yield* s.snapshot };
        }),
      ).pipe(Effect.provide(layer), Effect.scoped);

      const { events, snap } = await Effect.runPromise(prog);
      const types = events.map((e) => e.type);
      expect(types).toContain("turn_started");
      expect(types).toContain("prose_delta");
      expect(types).toContain("turn_ended");

      let k = createKernel();
      for (const e of events) k = applyPlayEvent(k, e);
      expect(k.story.some((b) => b.text === "I nod to Mira.")).toBe(true);
      expect(
        k.story.some((b) => b.text === "Mira looks at your hands, not your face."),
      ).toBe(true);
      expect(k.successTurnCount).toBe(1);
      expect(k.story.every((b) => typeof b.ts === "string")).toBe(true);
      // the session's own kernel agrees, opening message included
      expect(snap.story.map((b) => b.text)).toEqual([
        "Mira Venn watches you from the Salt Lamp doorway.",
        "I nod to Mira.",
        "Mira looks at your hands, not your face.",
      ]);
      // the Game Master saw the player's words
      expect(gm.calls[0]?.prompt).toBe("I nod to Mira.");
    } finally {
      await rmTempDir(root);
    }
  });

  test("after a Turn, snapshot story ts matches transcript.jsonl", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        fallback: says("Mira looks at your hands, not your face."),
      });
      const layer = playSessionLayer({ path: campaign, factory: gm.factory });
      const prog = withPlaySession((s) =>
        Effect.gen(function* () {
          yield* s.submit("I nod to Mira.");
          yield* untilIdle(s);
          const snap = yield* s.snapshot;
          const rows = yield* Effect.promise(() =>
            readTranscript(s.campaignPath),
          );
          expect(rows).toHaveLength(2);
          expect(snap.story.map((b) => b.ts)).toEqual(rows.map((r) => r.ts));
          expect(snap.story.map((b) => b.text)).toEqual(rows.map((r) => r.text));
          return snap;
        }),
      ).pipe(Effect.provide(layer), Effect.scoped);
      await Effect.runPromise(prog);
    } finally {
      await rmTempDir(root);
    }
  });

  test("interrupt while Turning fails the Turn without a GM row", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const thinking = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        steps: [
          async (c) => {
            c.think("The brine-well is deep.");
            thinking.resolve();
            await c.aborted();
          },
        ],
      });
      const layer = playSessionLayer({ path: campaign, factory: gm.factory });
      const prog = withPlaySession((s) =>
        Effect.gen(function* () {
          const events = yield* eventsDuring(
            s,
            Effect.gen(function* () {
              yield* s.submit("I wait at the brine-well.");
              // Stop once the Game Master is mid-thought
              yield* Effect.promise(() => thinking.promise);
              yield* s.interrupt();
            }),
            (e) => e.type === "turn_ended",
          );
          yield* untilIdle(s);
          return events.find((e) => e.type === "turn_ended");
        }),
      ).pipe(Effect.provide(layer), Effect.scoped);

      const ended = await Effect.runPromise(prog);
      expect(ended?.type).toBe("turn_ended");
      if (ended?.type === "turn_ended") {
        expect(ended.outcome).toBe("fail");
        expect(ended.reason).toBe("interrupt");
      }
      expect((await readTranscript(campaign)).map((r) => r.role)).toEqual([
        "player",
      ]);
    } finally {
      await rmTempDir(root);
    }
  });
});
