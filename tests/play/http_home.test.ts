import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpApp, HttpRouter } from "@effect/platform";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Layer } from "effect";
import { HomeSurface } from "../../src/home/index.ts";
import { mergeConfig } from "../../src/config.ts";
import { createRemoteWarmer } from "../../src/agent/llama_cpp.ts";
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
import { scriptedGameMaster, says } from "../helpers/game_master.ts";
import { fakeProvider, installLocalModels } from "../helpers/home.ts";
import { NativeRequest } from "./native_request.ts";

/**
 * Home HTTP routes over the real Home app: real HomeSurface, NQ's Home auth
 * adapter over OMP's real auth store and model registry, a real (model-less)
 * local runtime installation, real Campaign folders, and the real Play
 * routes. Faked: the Provider's sign-in, the Game Master's model, and the
 * remote endpoint a warm-up pings.
 */

const ORIGIN = "http://127.0.0.1:7737";

async function boot(
  root: string,
  extra: {
    model?: string;
    warmModel?: (model: string | undefined) => void;
  } = {},
) {
  await writePack(path.join(root, "packs", "brinewatch"), {
    "seed.md": "# Brinewatch\n\n## Opening message\n\nMira Venn watches you.\n",
    "player_sheet.md": "## Description\nRen Caldew.\n",
    "pack.yaml": "name: Brinewatch\ndescription: Salt dock.\n",
  });
  const provider = await fakeProvider();
  const local = await installLocalModels();
  const gm = await scriptedGameMaster({ fallback: says("Mira nods.") });
  const surface = new HomeSurface({
    config: mergeConfig({}, extra.model ? { model: extra.model } : {}),
    configPath: path.join(root, "config.toml"),
    packsDir: path.join(root, "packs"),
    campaignsDir: path.join(root, "campaigns"),
    factory: gm.factory,
    auth: provider.auth,
    ...(extra.warmModel ? { warmModel: extra.warmModel } : {}),
  });
  const layer = Layer.merge(
    homeServiceLayer(surface),
    Layer.succeed(PlaySession, playSessionFromHome(surface)),
  );
  const app = HttpRouter.concat(homeHttpApp, serveHttpApp);
  const web = await HttpApp.toWebHandlerLayer(app, layer);
  return {
    surface,
    provider,
    handler: web.handler,
    async dispose() {
      await surface.leave();
      await web.dispose();
      await local.remove();
      provider.dispose();
    },
  };
}

function post(
  pathname: string,
  body?: unknown,
  origin: string | null = ORIGIN,
) {
  return new NativeRequest(`http://127.0.0.1:7737${pathname}`, {
    method: "POST",
    headers: {
      Host: "127.0.0.1:7737",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(origin ? { Origin: origin } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Home HTTP routes", () => {
  test("GET /api/home lists packs; POST birth is 201; leave is 204; Origin 403", async () => {
    const root = await makeTempDir();
    try {
      const { handler, dispose } = await boot(root);
      try {
        const home = await handler(new NativeRequest(`${ORIGIN}/api/home`));
        expect(home.status).toBe(200);
        const snap = (await home.json()) as {
          packs: Array<{ name: string }>;
          open: unknown;
        };
        expect(snap.packs.map((p) => p.name)).toEqual(["Brinewatch"]);
        expect(snap.open).toBeNull();
        expect(JSON.stringify(snap)).not.toMatch(/fredicus/i);

        const denied = await handler(
          post(
            "/api/campaigns",
            { pack: "brinewatch", title: "Dock Nights" },
            null,
          ),
        );
        expect(denied.status).toBe(403);

        const created = await handler(
          post("/api/campaigns", { pack: "brinewatch", title: "Dock Nights" }),
        );
        expect(created.status).toBe(201);
        const body = (await created.json()) as { id: string; name: string };
        expect(body.name).toBe("Dock Nights");

        // the book is open: the Play routes read the new Campaign's files
        const sheet = await handler(
          new NativeRequest(`${ORIGIN}/api/inspect/sheet`),
        );
        expect(sheet.status).toBe(200);
        expect(JSON.stringify(await sheet.json())).toContain("Ren Caldew");

        const busy = await handler(
          post("/api/campaigns", { pack: "brinewatch", title: "Again" }),
        );
        expect(busy.status).toBe(409);

        const left = await handler(post("/api/leave"));
        expect(left.status).toBe(204);

        const listed = await handler(new NativeRequest(`${ORIGIN}/api/home`));
        const after = (await listed.json()) as {
          campaigns: Array<{ name: string }>;
          open: unknown;
        };
        expect(after.campaigns.map((c) => c.name)).toEqual(["Dock Nights"]);
        expect(after.open).toBeNull();

        const deleted = await handler(
          post("/api/campaigns/delete", { id: body.id }),
        );
        expect(deleted.status).toBe(204);
        expect(
          await Bun.file(
            path.join(root, "campaigns", "Dock Nights", "campaign.yaml"),
          ).exists(),
        ).toBe(false);

        const afterDelete = await handler(
          new NativeRequest(`${ORIGIN}/api/home`),
        );
        const deletedSnap = (await afterDelete.json()) as {
          campaigns: Array<{ name: string }>;
        };
        expect(deletedSnap.campaigns).toEqual([]);

        const missing = await handler(
          post("/api/campaigns/delete", { id: body.id }),
        );
        expect(missing.status).toBe(404);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("sign-in prompt goes to the Provider; events without a Campaign is 409", async () => {
    const root = await makeTempDir();
    try {
      const { handler, dispose, provider } = await boot(root);
      try {
        const start = await handler(
          post("/api/login", { provider: "Lanternlight" }),
        );
        expect(start.status).toBe(202);
        const mid = (await start.json()) as {
          login: { phase: string; message?: string; placeholder?: string };
        };
        expect(mid.login.phase).toBe("awaiting_prompt");
        expect(mid.login.message).toBe("Paste your key.");
        expect(mid.login.placeholder).toBeUndefined();

        const prompt = await handler(
          post("/api/login/prompt", { text: "sk-test" }),
        );
        expect(prompt.status).toBe(200);
        const afterPrompt = (await prompt.json()) as {
          login: { phase: string };
          models: Array<{ name: string }>;
        };
        expect(provider.signIns).toEqual(["sk-test"]);
        expect(afterPrompt.login.phase).toBe("awaiting_model");
        expect(afterPrompt.models.map((m) => m.name)).toEqual([
          "Lamp 2",
          "Lamp 1",
        ]);

        const ev = await handler(new NativeRequest(`${ORIGIN}/api/events`));
        expect(ev.status).toBe(409);

        const rejected = await handler(
          post("/api/login/model", { model: "openai-codex/not-real" }),
        );
        expect(rejected.status).toBe(400);
        const rejectedBody = (await rejected.json()) as { error: string };
        expect(rejectedBody.error).not.toMatch(/\/|openai-codex|~|\.toml/);

        const cancel = await handler(post("/api/login/cancel", {}));
        expect(cancel.status).toBe(202);
        expect(
          ((await cancel.json()) as { login: { phase: string } }).login.phase,
        ).toBe("idle");
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("settings route updates the active timeout and persists it", async () => {
    const root = await makeTempDir();
    try {
      const { handler, dispose, surface } = await boot(root);
      try {
        const home = await handler(new NativeRequest(`${ORIGIN}/api/home`));
        const snap = (await home.json()) as {
          settings: Record<string, unknown> & { turnTimeoutSec: number };
        };
        expect(snap.settings.turnTimeoutSec).toBe(180);

        const updated = { ...snap.settings, turnTimeoutSec: 900 };
        const saved = await handler(post("/api/settings", updated));
        expect(saved.status).toBe(200);
        expect(surface.config.turnTimeoutMs).toBe(900_000);
        const persisted = await Bun.file(path.join(root, "config.toml")).text();
        expect(persisted).toContain("timeout = 900");

        const invalid = await handler(
          post("/api/settings", { ...updated, turnTimeoutSec: 0 }),
        );
        expect(invalid.status).toBe(400);
        expect(surface.config.turnTimeoutMs).toBe(900_000);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("typing wakes a remote llama.cpp Game Master once per window, and nothing else", async () => {
    const root = await makeTempDir();
    // the remote endpoint is declared the way players declare it, in OMP's
    // models.yml, and resolved by NQ's real lookup; the preload points OMP's
    // agent dir into the test sandbox, and this refuses to write anywhere else
    const agentDir = getAgentDir();
    if (
      !path.resolve(agentDir).startsWith(path.resolve(os.tmpdir()) + path.sep)
    ) {
      throw new Error(
        `refusing to write models.yml outside the sandbox: ${agentDir}`,
      );
    }
    const modelsYml = path.join(agentDir, "models.yml");
    if (await Bun.file(modelsYml).exists()) {
      throw new Error(`sandboxed models.yml already exists: ${modelsYml}`);
    }
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      modelsYml,
      [
        "providers:",
        "  llama.cpp-runpod:",
        "    baseUrl: https://ep.api.runpod.ai/v1",
        "    api: openai-completions",
        "    apiKey: k",
        "    models:",
        "      - id: qwen",
        "        name: Qwen (Runpod)",
        "        reasoning: true",
        "        contextWindow: 32768",
        "        maxTokens: 8192",
        "",
      ].join("\n"),
    );
    // OMP reads models.yml once per process; a player writes it before nq starts
    ModelsConfigFile.invalidate();
    try {
      const pings: Array<{ url: string; auth: string | null }> = [];
      let clock = 1_000_000;
      let offline = false;
      // only the network is faked
      const remoteFetch = (async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        pings.push({ url, auth: headers.get("authorization") });
        if (offline) throw new Error("offline");
        return new Response("ok");
      }) as typeof fetch;
      const warm = createRemoteWarmer({ fetch: remoteFetch, now: () => clock });
      const settled = async (count: number) => {
        const deadline = Date.now() + 5_000;
        while (pings.length < count && Date.now() < deadline) {
          await Bun.sleep(1);
        }
      };

      const remote = await boot(root, {
        model: "llama.cpp-runpod/qwen",
        warmModel: (model) => void warm(model),
      });
      try {
        const warmPost = (origin: string | null = ORIGIN) =>
          remote.handler(post("/api/model/warm", undefined, origin));
        expect((await warmPost(null)).status).toBe(403);
        expect((await warmPost()).status).toBe(204);
        expect((await warmPost()).status).toBe(204);
        await settled(1);
        expect(pings).toEqual([
          { url: "https://ep.api.runpod.ai/ping", auth: "Bearer k" },
        ]);

        clock += 16_000;
        offline = true;
        // a failed wake is swallowed: the route still answers
        expect((await warmPost()).status).toBe(204);
        await settled(2);
        expect(pings).toHaveLength(2);
      } finally {
        await remote.dispose();
      }

      // a model NQ runs itself, or a hosted Provider, is never pinged
      for (const model of ["llama.cpp/qwen3.8-27b", "xai-oauth/grok-4.6"]) {
        clock += 16_000;
        const other = await boot(path.join(root, model.replace(/\W+/g, "-")), {
          model,
          warmModel: (m) => void warm(m),
        });
        try {
          const res = await other.handler(post("/api/model/warm"));
          expect(res.status).toBe(204);
        } finally {
          await other.dispose();
        }
      }
      await Bun.sleep(0);
      expect(pings).toHaveLength(2);
    } finally {
      await rm(modelsYml, { force: true });
      ModelsConfigFile.invalidate();
      await rmTempDir(root);
    }
  });
});
