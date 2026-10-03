import { describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import {
  CampaignError,
  inspectHash,
  listCampaignHistory,
  PLAYER_SHEET_MD,
  SEED_MD,
  STORY_BEATS_MD,
} from "../../src/campaign/index.ts";
import {
  buildHistoryHandoff,
  PlayLoop,
  playSessionLayer,
  type PlayEvent,
  withPlaySession,
} from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster, says, type ModelCall } from "../helpers/game_master.ts";

type Line = { role: string; content: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part ? String(part.text) : "",
    )
    .join("");
}

/** Dialogue the model was sent; hidden system lines are `system`. */
function dialogue(call: ModelCall): Line[] {
  return call.context.messages.map((m) => ({
    role: m.role === "developer" ? "system" : m.role,
    content: textOf((m as { content?: unknown }).content),
  }));
}

type Journal = { file: string; parent?: string; messages: Line[] };

/**
 * The OMP session journals under the Campaign, oldest first. A replaced play
 * session is a new root journal (no parent) seeded with the rebuild history.
 */
async function journals(campaign: string): Promise<Journal[]> {
  const dir = path.join(campaign, ".nq", "sessions");
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const out: Journal[] = [];
  for (const file of files) {
    const journal: Journal = { file, messages: [] };
    for (const line of (await readFile(path.join(dir, file), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === "session" && entry.parentSession) journal.parent = entry.parentSession;
      if (entry.type === "message") {
        journal.messages.push({
          role: entry.message.role === "developer" ? "system" : entry.message.role,
          content: textOf(entry.message.content),
        });
      }
    }
    out.push(journal);
  }
  return out;
}

async function newRootJournals(campaign: string, before: Journal[]): Promise<Journal[]> {
  const seen = new Set(before.map((j) => j.file));
  return (await journals(campaign)).filter((j) => !seen.has(j.file) && !j.parent);
}

describe("Play Loop — inspect save", () => {
  test("save writes disk, commits, and replaces the session with a full prime", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        sheet: "## Description\nRen Caldew\n",
      });
      await Bun.write(path.join(campaign, STORY_BEATS_MD), "- old beat\n");
      const gm = await scriptedGameMaster({ fallback: says("Fog parts.") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("I step forward");
      const before = await listCampaignHistory(campaign);
      const journalsBefore = await journals(campaign);
      const session = loop.currentSession;
      const loaded = await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8");
      const next = "## Description\n**Ren Caldew** — dock runner.\n";

      const saved = await loop.saveInspect("sheet", next, inspectHash(loaded));
      expect(saved.text).toBe(next);
      expect(await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8")).toBe(
        next,
      );
      expect(await readFile(path.join(campaign, STORY_BEATS_MD), "utf8")).toBe(
        "- old beat\n",
      );

      const history = await listCampaignHistory(campaign);
      expect(history).toHaveLength(before.length + 1);
      expect(history[0]?.message).toBe("inspect");

      // replaced: a new OMP session, journaled with the full transcript + handoff
      expect(loop.currentSession).not.toBe(session);
      expect(loop.hasPrimedSession).toBe(true);
      const rebuilt = await newRootJournals(campaign, journalsBefore);
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0]!.messages).toEqual([
        { role: "user", content: "I step forward" },
        { role: "assistant", content: "Fog parts." },
        { role: "system", content: buildHistoryHandoff("full") },
      ]);

      // the next Turn talks to that session, primed with the saved sheet
      await loop.turn("I look around");
      const call = gm.calls.at(-1)!;
      expect(call.system).toContain("**Ren Caldew** — dock runner.");
      expect(dialogue(call)).toEqual([
        { role: "user", content: "I step forward" },
        { role: "assistant", content: "Fog parts." },
        { role: "system", content: buildHistoryHandoff("full") },
        { role: "user", content: "I look around" },
      ]);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("stale save does not write, commit, or replace the session", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        sheet: "## Description\nRen Caldew\n",
      });
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const session = loop.currentSession;
      const before = await listCampaignHistory(campaign);
      const journalsBefore = await journals(campaign);
      const loaded = await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8");
      const disk = "## Description\nchanged on disk\n";
      await writeFile(path.join(campaign, PLAYER_SHEET_MD), disk);

      let err: unknown;
      try {
        await loop.saveInspect("sheet", "player edit\n", inspectHash(loaded));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CampaignError);
      expect((err as CampaignError).code).toBe("stale");
      expect((err as CampaignError).diskText).toBe(disk);
      expect(await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8")).toBe(
        disk,
      );
      expect(await listCampaignHistory(campaign)).toEqual(before);
      expect(loop.currentSession).toBe(session);
      expect(await journals(campaign)).toEqual(journalsBefore);
      expect(loop.loopState).toBe("idle");
      expect(gm.calls).toHaveLength(0);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("create dossier commits and replaces the session", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const session = loop.currentSession;
      const before = await listCampaignHistory(campaign);

      const created = await loop.createDossier(
        "mira-venn",
        "---\nname: Mira Venn\n---\nInnkeeper.\n",
      );
      expect(created.slug).toBe("mira-venn");
      expect(
        await readFile(path.join(campaign, "dossiers", "mira-venn.md"), "utf8"),
      ).toContain("Innkeeper.");
      expect((await listCampaignHistory(campaign))[0]?.message).toBe("dossier");
      expect((await listCampaignHistory(campaign)).length).toBe(before.length + 1);
      expect(loop.currentSession).not.toBe(session);
      // no transcript yet: the rebuilt session is primed but seeds no history
      expect(await journals(campaign)).toEqual([]);

      await loop.turn("I look for the innkeeper");
      const call = gm.calls.at(-1)!;
      expect(call.system).toContain("dossiers/mira-venn.md");
      expect(dialogue(call)).toEqual([
        { role: "user", content: "I look for the innkeeper" },
      ]);

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("archive dossier commits, replaces the session, and drops the pin", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        dossiers: {
          pell:
            "---\nname: Pell\naliases: []\nkind: person\n---\nA locksmith.\n",
        },
      });
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      await loop.turn("I knock");
      expect(gm.calls.at(-1)!.system).toContain('<file path="dossiers/pell.md:1-5">');
      const session = loop.currentSession;
      const before = await listCampaignHistory(campaign);

      const result = await loop.archiveDossier("pell", true);
      expect(result.moved).toBe(true);
      expect(result.archived).toBe(true);
      expect(
        await readFile(
          path.join(campaign, "dossiers", "archive", "pell.md"),
          "utf8",
        ),
      ).toContain("locksmith");
      expect((await listCampaignHistory(campaign))[0]?.message).toBe("archive");
      expect((await listCampaignHistory(campaign)).length).toBe(before.length + 1);
      expect(loop.currentSession).not.toBe(session);
      await loop.turn("I knock again");
      expect(gm.calls.at(-1)!.system).not.toContain("dossiers/pell.md");

      const restored = await loop.archiveDossier("pell", false);
      expect(restored.archived).toBe(false);
      expect((await listCampaignHistory(campaign))[0]?.message).toBe(
        "unarchive",
      );

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("save seed commits and rebuilds the system prompt", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Brinewatch\n\nMira keeps the Salt Lamp.\n",
      });
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const seed = await readFile(path.join(campaign, SEED_MD), "utf8");
      const before = await listCampaignHistory(campaign);
      const session = loop.currentSession;

      const next = "# Brinewatch\n\nKell keeps the Salt Lamp now.\n";
      await loop.saveInspect("seed", next, inspectHash(seed));
      expect(await readFile(path.join(campaign, SEED_MD), "utf8")).toBe(next);
      expect((await listCampaignHistory(campaign)).length).toBe(
        before.length + 1,
      );
      expect(loop.currentSession).not.toBe(session);
      expect(loop.loopState).toBe("idle");

      await loop.turn("Who keeps the lamp?");
      const system = gm.calls.at(-1)!.system;
      expect(system).toContain("Kell keeps the Salt Lamp now.");
      expect(system).not.toContain("Mira keeps the Salt Lamp.");

      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("save and create refuse while Turning; authoring blocks overlap", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        sheet: "## Description\nRen Caldew\n",
      });
      const loaded = await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8");
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
      const turn = loop.turn("hold");
      await entered.promise;

      let saveErr: unknown;
      try {
        await loop.saveInspect("sheet", "x\n", inspectHash(loaded));
      } catch (e) {
        saveErr = e;
      }
      expect((saveErr as CampaignError).code).toBe("busy");

      let createErr: unknown;
      try {
        await loop.createDossier("kell-brine");
      } catch (e) {
        createErr = e;
      }
      expect((createErr as CampaignError).code).toBe("busy");

      loop.interrupt();
      expect((await turn).reason).toBe("interrupt");
      expect(await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8")).toBe(loaded);
      expect(
        await Bun.file(path.join(campaign, "dossiers", "kell-brine.md")).exists(),
      ).toBe(false);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("overlapping save cannot both pass Idle", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        sheet: "## Description\nRen Caldew\n",
      });
      const loaded = await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8");
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      // A second save attempted at each story swap the first save announces:
      // before it writes, and after the session replace but before Idle.
      // settle at creation: a rejection left unobserved until `await save`
      // is an unhandled rejection, which fails this test and the next one
      const settled = (attempt: Promise<unknown>): Promise<unknown> =>
        attempt.then(
          () => undefined,
          (e: unknown) => e,
        );
      const overlaps: Array<{ state: string; attempt: Promise<unknown> }> = [];
      let saving = false;
      let loop: PlayLoop;
      loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        onEvent: (e: PlayEvent) => {
          if (!saving || e.type !== "story_replaced") return;
          overlaps.push({
            state: loop.loopState,
            attempt: settled(
              loop.saveInspect("sheet", "again\n", inspectHash(loaded)),
            ),
          });
        },
      });
      await loop.open();
      const session = loop.currentSession;
      saving = true;
      const save = loop.saveInspect(
        "sheet",
        "## Description\nedited\n",
        inspectHash(loaded),
      );
      expect(loop.loopState).toBe("authoring");
      const immediate = settled(
        loop.saveInspect("sheet", "again\n", inspectHash(loaded)),
      );

      await save;
      saving = false;
      expect(overlaps.map((o) => o.state)).toEqual(["authoring", "authoring"]);
      for (const second of [immediate, ...overlaps.map((o) => o.attempt)]) {
        const err = await second;
        expect(err).toBeInstanceOf(CampaignError);
        expect((err as CampaignError).code).toBe("busy");
      }
      expect(loop.currentSession).not.toBe(session);
      expect(await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8")).toBe(
        "## Description\nedited\n",
      );
      expect(loop.loopState).toBe("idle");
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("same-size sheet rewrite still commits inspect", async () => {
    const root = await makeTempDir();
    try {
      const first =
        "## Description\nRen Caldew.\n\n## Inventory\n\n## Powers\n\n## Notes\n";
      const second =
        "## Description\nRen CALDEW.\n\n## Inventory\n\n## Powers\n\n## Notes\n";
      expect(first.length).toBe(second.length);
      const campaign = await birthCampaign(root, { sheet: first });
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      const loop = new PlayLoop({ path: campaign, factory: gm.factory });
      await loop.open();
      const before = await listCampaignHistory(campaign);
      await loop.saveInspect("sheet", second, inspectHash(first));
      const history = await listCampaignHistory(campaign);
      expect(history).toHaveLength(before.length + 1);
      expect(history[0]?.message).toBe("inspect");
      expect(await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8")).toBe(
        second,
      );
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("PlaySession saveInspect and createDossier update disk", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        sheet: "## Description\nRen Caldew\n",
      });
      const loaded = await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8");
      const gm = await scriptedGameMaster({ fallback: says("ok") });
      const layer = playSessionLayer({ path: campaign, factory: gm.factory });
      const prog = withPlaySession((s) =>
        Effect.gen(function* () {
          const saved = yield* s.saveInspect(
            "sheet",
            "## Description\nedited sheet\n",
            inspectHash(loaded),
          );
          expect(saved.text).toContain("edited sheet");
          const created = yield* s.createDossier("kell-brine", "Ferry hand.\n");
          expect(created.slug).toBe("kell-brine");
        }),
      ).pipe(Effect.provide(layer), Effect.scoped);
      await Effect.runPromise(prog);
      expect(await readFile(path.join(campaign, PLAYER_SHEET_MD), "utf8")).toContain(
        "edited sheet",
      );
      const dossier = await readFile(
        path.join(campaign, "dossiers", "kell-brine.md"),
        "utf8",
      );
      expect(dossier).toContain("Ferry hand.");
      expect(dossier.startsWith("---\n")).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });
});
