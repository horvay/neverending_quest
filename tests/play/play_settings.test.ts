import { describe, expect, test } from "bun:test";
import path from "node:path";
import { HttpApp, HttpRouter } from "@effect/platform";
import { Layer } from "effect";
import { HomeSurface } from "../../src/home/index.ts";
import { mergeConfig } from "../../src/config.ts";
import {
  PlaySession,
} from "../../src/play/index.ts";
import { serveHttpApp } from "../../src/surfaces/web/http.ts";
import {
  homeHttpApp,
  homeServiceLayer,
  playSessionFromHome,
} from "../../src/surfaces/web/http_home.ts";
import { makeTempDir, rmTempDir, writePack } from "../helpers/fs.ts";
import { scriptedGameMaster, says, type ScriptStep } from "../helpers/game_master.ts";
import { NativeRequest } from "./native_request.ts";

const ORIGIN = "http://127.0.0.1:7737";

/** The real Home app over a real HomeSurface; only the model is scripted. */
async function boot(root: string, steps: ScriptStep[] = []) {
  await writePack(path.join(root, "packs", "brinewatch"), {
    "seed.md": "# Brinewatch\n\n## Opening message\n\nMira Venn watches you.\n",
    "player_sheet.md": "## Description\nRen Caldew.\n",
    "pack.yaml": "name: Brinewatch\ndescription: Salt dock.\n",
  });
  const gm = await scriptedGameMaster({ steps, fallback: says("Mira nods.") });
  const configPath = path.join(root, "config.toml");
  const surface = new HomeSurface({
    config: mergeConfig({}, {}),
    configPath,
    packsDir: path.join(root, "packs"),
    campaignsDir: path.join(root, "campaigns"),
    factory: gm.factory,
  });
  const layer = Layer.merge(
    homeServiceLayer(surface),
    Layer.succeed(PlaySession, playSessionFromHome(surface)),
  );
  const app = HttpRouter.concat(homeHttpApp, serveHttpApp);
  const web = await HttpApp.toWebHandlerLayer(app, layer);
  const post = (route: string, body: unknown) =>
    web.handler(
      new NativeRequest(`${ORIGIN}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: ORIGIN,
          Host: "127.0.0.1:7737",
        },
        body: JSON.stringify(body),
      }),
    );
  return { gm, configPath, post, dispose: web.dispose };
}

/**
 * Wait until the Play Loop takes commands again. Editing an unknown row is a
 * side-effect-free 404 once idle and 409 while the loop is still busy.
 */
async function waitForIdle(
  post: (route: string, body: unknown) => Promise<Response>,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    const probe = await post("/api/transcript/edit", {
      ts: "1970-01-01T00:00:00.000Z",
      text: "probe",
    });
    if (probe.status !== 409) return;
    await Bun.sleep(5);
  }
  throw new Error("play loop never became idle");
}

describe("book settings while a Campaign is open", () => {
  test("a new personality reaches the next Turn and the saved config", async () => {
    const root = await makeTempDir();
    const { gm, configPath, post, dispose } = await boot(root);
    try {
      expect((await post("/api/campaigns", { pack: "brinewatch", title: "Dock Nights" })).status).toBe(201);
      expect((await post("/api/turn", { text: "I wait." })).status).toBe(202);
      await waitForIdle(post);
      expect(gm.calls.at(-1)!.system).not.toContain("generous with names");

      const saved = await post("/api/settings/play", {
        gmPersonality: "Warm, plain-spoken, and generous with names.",
        turnTimeoutSec: 240,
        // not a live setting: the book cannot switch models mid-Campaign
        model: "someone/else",
      });
      expect(saved.status).toBe(200);
      const snap = (await saved.json()) as {
        settings: { gmPersonality: string; turnTimeoutSec: number; model: string };
      };
      expect(snap.settings.gmPersonality).toBe(
        "Warm, plain-spoken, and generous with names.",
      );
      expect(snap.settings.turnTimeoutSec).toBe(240);
      expect(snap.settings.model).toBe("");

      expect((await post("/api/turn", { text: "I ask her name." })).status).toBe(202);
      await waitForIdle(post);
      expect(gm.calls.at(-1)!.system).toContain(
        "Warm, plain-spoken, and generous with names.",
      );

      const config = await Bun.file(configPath).text();
      expect(config).toContain("timeout = 240");
      expect(config).toContain('gm_personality = "Warm, plain-spoken, and generous with names."');
      expect(config).not.toContain("someone/else");
    } finally {
      await dispose();
      await rmTempDir(root);
    }
  });

  test("saving waits for an Idle book, and needs an open Campaign", async () => {
    const root = await makeTempDir();
    const reply = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    const { post, dispose } = await boot(root, [
      async (call) => {
        call.say("Mira starts to answer");
        writing.resolve();
        await reply.promise;
        call.say(".");
      },
    ]);
    try {
      const closed = await post("/api/settings/play", { turnTimeoutSec: 90 });
      expect(closed.status).toBe(400);

      expect((await post("/api/campaigns", { pack: "brinewatch", title: "Dock Nights" })).status).toBe(201);
      expect((await post("/api/turn", { text: "I wait." })).status).toBe(202);
      await writing.promise;

      const busy = await post("/api/settings/play", { turnTimeoutSec: 90 });
      expect(busy.status).toBe(409);
      expect(((await busy.json()) as { error: string }).error).toContain(
        "Wait for the Game Master to finish",
      );

      reply.resolve();
      await waitForIdle(post);
      expect((await post("/api/settings/play", { turnTimeoutSec: 90 })).status).toBe(200);
    } finally {
      reply.resolve();
      await dispose();
      await rmTempDir(root);
    }
  });
});
