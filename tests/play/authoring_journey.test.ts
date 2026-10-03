import { describe, expect, test } from "bun:test";
import { HttpApp } from "@effect/platform";
import { Effect, Layer } from "effect";
import {
  listCampaignHistory,
  readScratch,
  readTranscript,
} from "../../src/campaign/index.ts";
import { serveHttpApp } from "../../src/surfaces/web/http.ts";
import {
  closePlayHandle,
  openPlayHandle,
  PlaySession,
  type PlayHandle,
} from "../../src/play/session.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, readText, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster, type ModelCall } from "../helpers/game_master.ts";

const ORIGIN = "http://127.0.0.1:7737";
const HOST = { Origin: ORIGIN, Host: "127.0.0.1:7737" };

/**
 * The Play Loop is Idle only after its final commit (the book already shows
 * Idle at `turn_ended`), so wait on the loop itself before the next command.
 */
async function idle(handle: PlayHandle, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (handle.loop.loopState !== "idle") {
    if (Date.now() > deadline) {
      throw new Error(`Play Loop stuck in ${handle.loop.loopState}`);
    }
    await Bun.sleep(1);
  }
}

describe("authoring HTTP journey", () => {
  test("one serve session: turn, scratch, edit, continue, inspect, hygiene, history", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        name: "journey",
        sheet:
          "## Description\nRen.\n\n## Inventory\n\n## Powers\n\n## Notes\n",
      });
      const seen: Array<{ kind: string; call: ModelCall }> = [];
      const gm = await scriptedGameMaster({
        steps: [
          // the Turn: think, check the sheet, then a reply that trails off
          (c) => {
            seen.push({ kind: "turn", call: c });
            c.think("Keep Mira dry.");
            c.tool("read", { path: "player_sheet.md" });
          },
          (c) => c.say("And then he"),
          // Continue finishes the same Game Master line
          (c) => {
            seen.push({ kind: "continue", call: c });
            c.say("picked up the sword…");
          },
          // light Memory Hygiene writes a beat through the real tool
          (c) => {
            seen.push({ kind: "hygiene", call: c });
            c.tool("write", {
              path: "story-beats.md",
              content: "- Ren waited; the stranger picked up the sword.\n",
            });
          },
          (c) => c.say("ignored hygiene"),
        ],
      });
      const handle = await Effect.runPromise(
        openPlayHandle({ path: campaign, factory: gm.factory }),
      );
      const { handler, dispose } = await HttpApp.toWebHandlerLayer(
        serveHttpApp,
        Layer.succeed(PlaySession, handle.api),
      );
      try {
        const json = (method: string, path: string, body?: unknown) =>
          handler(
            new Request(`${ORIGIN}${path}`, {
              method,
              headers: { ...HOST, "content-type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
            }),
          );

        const afterBirth = await listCampaignHistory(campaign);
        expect(afterBirth.length).toBeGreaterThanOrEqual(1);

        const turn = await json("POST", "/api/turn", { text: "I wait." });
        expect(turn.status).toBe(202);
        await idle(handle);
        const afterTurn = await readTranscript(campaign);
        expect(afterTurn.map((r) => [r.role, r.text])).toEqual([
          ["player", "I wait."],
          ["gm", "And then he"],
        ]);
        const gmRow = afterTurn[1]!;
        expect(seen[0]?.call.prompt).toBe("I wait.");

        const scratchRes = await handler(new Request(`${ORIGIN}/api/scratch`));
        expect(scratchRes.status).toBe(200);
        const scratchBody = (await scratchRes.json()) as {
          records: Array<{ ts: string; turn: number }>;
        };
        expect(scratchBody.records).toHaveLength(1);
        expect(scratchBody.records[0]?.ts).toBe(gmRow.ts);
        expect(scratchBody.records[0]?.turn).toBe(1);
        const diskScratch = await readScratch(campaign);
        expect(diskScratch[0]?.thinking).toContain("Keep Mira dry.");
        expect(diskScratch[0]?.tools.map((t) => t.name)).toEqual(["read"]);

        const edited = await json("POST", "/api/transcript/edit", {
          ts: gmRow.ts,
          text: "And then he",
        });
        expect(edited.status).toBe(204);
        await idle(handle);

        const cont = await json("POST", "/api/continue", { turn: 1 });
        expect(cont.status).toBe(202);
        await idle(handle);
        expect(seen[1]?.kind).toBe("continue");
        expect(seen[1]?.call.instruction).toContain(
          "[Continue — same Game Master line]",
        );
        const afterCont = await readTranscript(campaign);
        expect(afterCont).toHaveLength(2);
        expect(afterCont[1]).toMatchObject({
          ts: gmRow.ts,
          text: "And then he picked up the sword…",
        });
        expect(afterCont.some((r) => r.text === "(continue)")).toBe(false);

        const sheetGet = await handler(
          new Request(`${ORIGIN}/api/inspect/sheet`),
        );
        const sheet = (await sheetGet.json()) as { hash: string; text: string };
        const nextSheet =
          "## Description\n**Ren Caldew**\n\n## Inventory\n\n## Powers\n\n## Notes\n";
        const put = await handler(
          new Request(`${ORIGIN}/api/inspect/sheet`, {
            method: "PUT",
            headers: { ...HOST, "If-Match": sheet.hash },
            body: nextSheet,
          }),
        );
        expect(put.status).toBe(204);
        await idle(handle);
        expect(await readText(campaign, "player_sheet.md")).toBe(nextSheet);

        const hyg = await json("POST", "/api/hygiene", { mode: "light" });
        expect(hyg.status).toBe(202);
        await idle(handle);
        expect(seen[2]?.kind).toBe("hygiene");
        expect(seen[2]?.call.instruction).toContain("[Memory Hygiene — light");
        // the hygiene pass runs on the saved sheet
        expect(seen[2]?.call.system).toContain("**Ren Caldew**");
        expect(await readText(campaign, "story-beats.md")).toBe(
          "- Ren waited; the stranger picked up the sword.\n",
        );

        const hist = await handler(new Request(`${ORIGIN}/api/history`));
        expect(hist.status).toBe(200);
        const snapshots = (await hist.json()) as {
          entries: Array<{ turn: number; prose: string }>;
        };
        expect(snapshots.entries.some((s) => s.turn === 1)).toBe(true);
        expect(JSON.stringify(snapshots.entries).includes("\"oid\"")).toBe(
          false,
        );

        const log = await listCampaignHistory(campaign);
        expect(log.length).toBeGreaterThan(afterBirth.length);
        expect(log.some((e) => e.message.startsWith("turn"))).toBe(true);
        expect(log.some((e) => e.message.startsWith("continue"))).toBe(true);
        expect(log.some((e) => e.message === "inspect")).toBe(true);
        expect(log[0]?.message).toBe("light");
        expect(gm.calls).toHaveLength(5);
      } finally {
        await dispose();
        await closePlayHandle(handle);
      }
    } finally {
      await rmTempDir(root);
    }
  });
});
