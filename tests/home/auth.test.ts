import { describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { loadConfigFile, mergeConfig } from "../../src/config.ts";
import { SEED_MD } from "../../src/campaign/paths.ts";
import { HomeError, HomeSurface } from "../../src/home/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir, writePack } from "../helpers/fs.ts";
import { startLocalHost } from "../helpers/local_host.ts";
import { scriptedGameMaster } from "../helpers/game_master.ts";
import {
  fakeProvider,
  installLocalModels,
  type FakeProvider,
  type LocalInstall,
} from "../helpers/home.ts";

/**
 * Home sign-in, model choice and local setup over NQ's real Home adapter and
 * OMP's real auth store and model registry. Faked: the Provider's sign-in and
 * catalog (registered like an OMP extension), the browser, the local engine's
 * warm-up, and the Game Master's model.
 */

/** Wait for an async login to reach `phase` instead of sleeping. */
async function waitForLoginPhase(
  surface: HomeSurface,
  phase: string,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await surface.snapshot()).login.phase === phase) return;
    await Bun.sleep(2);
  }
  throw new Error(`login never reached ${phase}`);
}

async function withHome(
  run: (ctx: {
    root: string;
    provider: FakeProvider;
    surface: (
      extra?: Partial<ConstructorParameters<typeof HomeSurface>[0]>,
    ) => Promise<HomeSurface>;
    /** Install local models (the runtime starts installed, with none). */
    local: (models: Array<{ alias: string }>) => Promise<LocalInstall>;
  }) => Promise<void>,
  providerOpts: Parameters<typeof fakeProvider>[0] = {},
): Promise<void> {
  const root = await makeTempDir();
  const provider = await fakeProvider(providerOpts);
  const install = await installLocalModels();
  let n = 0;
  try {
    await run({
      root,
      provider,
      surface: async (extra = {}) => {
        n += 1;
        return new HomeSurface({
          config: mergeConfig({}, {}),
          configPath: path.join(root, `config-${n}.toml`),
          packsDir: path.join(root, "packs"),
          campaignsDir: path.join(root, "campaigns"),
          factory: (await scriptedGameMaster()).factory,
          auth: provider.auth,
          ...extra,
        });
      },
      local: async (models) => {
        await install.setModels(models);
        return install;
      },
    });
  } finally {
    await install.remove();
    provider.dispose();
    await rmTempDir(root);
  }
}

describe("Home login hooks", () => {
  test("sign-in pastes a key through OMP's store and persists the chosen model", async () => {
    await withHome(async ({ root, provider, surface: make }) => {
      const opened: string[] = [];
      const surface = await make({
        configPath: path.join(root, "config.toml"),
        openBrowser: async (url) => {
          opened.push(url);
        },
      });

      let snap = await surface.snapshot();
      // the featured row is OMP's real Provider catalog, renamed for players
      expect(snap.providers.featured.map((p) => p.name)).toEqual([
        "Grok",
        "Claude",
        "ChatGPT",
      ]);
      expect(snap.providers.more.map((p) => p.name)).toContain("Lanternlight");
      expect(snap.providers.more.map((p) => p.name)).not.toContain(
        "This computer",
      );

      const started = surface.startLogin("Lanternlight");
      await waitForLoginPhase(surface, "awaiting_prompt");
      snap = await surface.snapshot();
      expect(opened).toEqual(["https://lanternlight.test/sign-in"]);
      expect(snap.login.phase).toBe("awaiting_prompt");
      // OMP's "Paste your API key" in player words
      expect(snap.login.message).toBe("Paste your key.");
      expect(snap.login.placeholder).toBeUndefined();
      expect(snap.signedIn).toBeNull();
      expect(snap.login.message).not.toMatch(/auth-broker|config\.toml|OAuth/i);

      await surface.completePrompt("sk-test");
      await started;
      expect(provider.signIns).toEqual(["sk-test"]);
      expect(provider.storage.hasAuth(provider.id)).toBe(true);
      snap = await surface.snapshot();
      expect(snap.login.phase).toBe("awaiting_model");
      expect(snap.models?.map((m) => m.name)).toEqual(["Lamp 2", "Lamp 1"]);
      expect(
        snap.providers.more.find((p) => p.name === "Lanternlight")?.connected,
      ).toBe(true);

      // a model without thinking levels is chosen outright
      await surface.pickModel("Lamp 1");
      const file = await loadConfigFile(path.join(root, "config.toml"));
      expect(file.model).toBe(`${provider.id}/lamp-1`);
      snap = await surface.snapshot();
      expect(snap.login.phase).toBe("idle");
      expect(snap.signedIn?.model).toBe("Lamp 1 · Low");

      await expect(
        surface.pickModel("openai-codex/not-a-model"),
      ).rejects.toBeInstanceOf(HomeError);
    });
  });

  test("model pick then thinking levels from the model's own efforts", async () => {
    await withHome(async ({ root, provider, surface: make }) => {
      const surface = await make({
        configPath: path.join(root, "config.toml"),
      });
      void surface.startLogin("Lanternlight");
      await waitForLoginPhase(surface, "awaiting_prompt");
      await surface.completePrompt("sk-test");
      await waitForLoginPhase(surface, "awaiting_model");
      await surface.pickModel("Lamp 2");
      let snap = await surface.snapshot();
      expect(snap.login.phase).toBe("awaiting_reasoning");
      expect(snap.login.message).toBe("How hard should it think?");
      expect(snap.reasoning?.map((r) => r.name)).toEqual([
        "Low",
        "Medium",
        "High",
        "Extra high",
      ]);

      await surface.pickReasoning("Extra high");
      const file = await loadConfigFile(path.join(root, "config.toml"));
      expect(file.model).toBe(`${provider.id}/lamp-2`);
      expect(file.reasoning).toBe("xhigh");
      snap = await surface.snapshot();
      expect(snap.login.phase).toBe("idle");
      expect(snap.signedIn?.model).toBe("Lamp 2 · Extra high");
    });
  });

  test("provider copy never leaks selectors, paths, or OMP names", async () => {
    await withHome(
      async ({ surface: make }) => {
        const surface = await make();
        void surface.startLogin("Lanternlight");
        await waitForLoginPhase(surface, "awaiting_prompt");
        const snap = await surface.snapshot();
        expect(snap.login.message).toBeTruthy();
        expect(snap.login.message).not.toMatch(
          /xai-oauth|llama-cpp-local|config\.toml|~\/|OAuth|omp/i,
        );
        expect(snap.login.message).toContain("token");
        surface.cancelLogin();
        expect((await surface.snapshot()).login.phase).toBe("idle");
      },
      {
        login: {
          url: "https://lanternlight.test/sign-in",
          prompt:
            "Paste the llama-cpp-local token for xai-oauth/grok-4.6 from ~/.config/nq/config.toml (OAuth via omp)",
        },
      },
    );
  });

  test("a failed Provider sign-in shows player copy, not the error", async () => {
    await withHome(
      async ({ surface: make, provider }) => {
        const surface = await make();
        void surface.startLogin("Lanternlight");
        await waitForLoginPhase(surface, "error");
        const snap = await surface.snapshot();
        expect(snap.login.message).toBe("Could not sign in. Try again.");
        expect(snap.signedIn).toBeNull();
        expect(provider.storage.hasAuth(provider.id)).toBe(false);
      },
      {
        login: { fail: "401 invalid_grant from https://api.lanternlight.test" },
      },
    );
  });

  test("Esc dismisses model pick; a device-code Provider opens its page and waits for the code", async () => {
    await withHome(async ({ surface: make }) => {
      const models = await make();
      void models.startLogin("Lanternlight");
      await waitForLoginPhase(models, "awaiting_prompt");
      await models.completePrompt("sk-test");
      await waitForLoginPhase(models, "awaiting_model");
      models.cancelLogin();
      expect((await models.snapshot()).login.phase).toBe("idle");
    });

    await withHome(
      async ({ surface: make }) => {
        const opened: string[] = [];
        const device = await make({
          openBrowser: async (url) => {
            opened.push(url);
          },
        });
        void device.startLogin("Lanternlight");
        await waitForLoginPhase(device, "awaiting_prompt");
        expect(opened).toEqual(["https://lanternlight.test/login/device"]);
        const snap = await device.snapshot();
        expect(snap.login.phase).toBe("awaiting_prompt");
        expect(snap.login.message).toBe("Paste the code from the browser.");
        device.cancelLogin();
      },
      {
        login: {
          url: "https://lanternlight.test/login/device",
          prompt: "Paste the authorization code (or full redirect URL):",
        },
      },
    );
  });

  test("This computer appears only with a local installation and activates without a browser", async () => {
    await withHome(async ({ root, provider, surface: make, local }) => {
      const hidden = await make();
      await hidden.refreshLocal();
      expect(
        (await hidden.snapshot()).providers.featured.some(
          (p) => p.name === "This computer",
        ),
      ).toBe(false);
      await expect(hidden.startLogin("This computer")).rejects.toMatchObject({
        message: "A local Game Master is not installed.",
      });

      await local([{ alias: "marsh-7b" }]);
      const opened: string[] = [];
      const prepared: Array<{
        model: string | undefined;
        contextTokens?: number;
        reasoningTokens?: number;
      }> = [];
      const configPath = path.join(root, "local.toml");
      const shown = await make({
        configPath,
        prepareModel: async (model, opts) => {
          prepared.push({
            model,
            contextTokens: opts.contextTokens,
            reasoningTokens: opts.reasoningTokens,
          });
        },
        openBrowser: async (url) => {
          opened.push(url);
        },
      });
      await shown.refreshLocal();
      expect(
        (await shown.snapshot()).providers.featured.map((p) => p.name),
      ).toContain("This computer");

      await shown.startLogin("This computer");
      let snap = await shown.snapshot();
      expect(snap.login.phase).toBe("awaiting_local");
      expect(snap.models?.map((m) => m.selector)).toEqual([
        "llama.cpp/marsh-7b",
      ]);
      await shown.pickLocalModel({
        model: "llama.cpp/marsh-7b",
        contextTokens: 32_768,
        reasoningTokens: -1,
        reasoning: "high",
      });
      snap = await shown.snapshot();
      expect(opened).toEqual([]);
      // OMP's own llama.cpp sign-in never ran
      expect(provider.storage.hasAuth("llama.cpp")).toBe(false);
      expect(prepared).toEqual([
        {
          model: "llama.cpp/marsh-7b",
          contextTokens: 32_768,
          reasoningTokens: -1,
        },
      ]);
      expect(snap.login.phase).toBe("idle");
      expect(snap.signedIn?.modelSelector).toBe("llama.cpp/marsh-7b");
      const saved = await loadConfigFile(configPath);
      expect(saved.model).toBe("llama.cpp/marsh-7b");
      // the 30k default ceiling would overflow a 32k engine: 80% of it is kept
      expect(saved.compactCeilingTokens).toBe(26_214);
      expect(snap.settings.compactCeilingTokens).toBe(26_214);
    });
  });

  test("local selection warms before it persists", async () => {
    await withHome(async ({ root, surface: make, local }) => {
      await local([{ alias: "one" }, { alias: "two" }]);
      const configPath = path.join(root, "local.toml");
      const warming = Promise.withResolvers<void>();
      const prepared: string[] = [];
      const surface = await make({
        configPath,
        prepareModel: async (model, opts) => {
          if (model) {
            prepared.push(
              `${model}:${opts.contextTokens}:${opts.reasoningTokens}`,
            );
          }
          await warming.promise;
        },
      });

      await surface.snapshot();
      expect(prepared).toEqual([]);

      await surface.startLogin("This computer");
      expect((await surface.snapshot()).models?.map((m) => m.name)).toEqual([
        "one",
        "two",
      ]);
      const picking = surface.pickLocalModel({
        model: "llama.cpp/two",
        contextTokens: 32_768,
        reasoningTokens: 2_048,
        reasoning: "high",
      });
      await Promise.resolve();
      expect((await surface.snapshot()).login).toEqual({
        phase: "working",
        message: "Warming the Game Master…",
      });
      expect((await loadConfigFile(configPath)).model).toBeUndefined();

      warming.resolve();
      await picking;
      expect(prepared).toEqual(["llama.cpp/two:32768:2048"]);
      const saved = await loadConfigFile(configPath);
      expect(saved.model).toBe("llama.cpp/two");
      expect(saved.reasoning).toBe("high");
      expect(saved.localContextTokens).toBe(32_768);
      expect(saved.localReasoningTokens).toBe(2_048);
    });
  });

  test("cancelling local warmup aborts without persisting the selection", async () => {
    await withHome(async ({ root, surface: make, local }) => {
      await local([{ alias: "one" }]);
      const configPath = path.join(root, "local.toml");
      let aborted = false;
      const surface = await make({
        configPath,
        prepareModel: async (_model, opts) =>
          new Promise<void>((_resolve, reject) => {
            opts.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          }),
      });

      await surface.snapshot();
      await surface.startLogin("This computer");
      const warming = surface.pickLocalModel({
        model: "llama.cpp/one",
        contextTokens: 32_768,
        reasoningTokens: 2_048,
        reasoning: "low",
      });
      await Promise.resolve();
      expect((await surface.snapshot()).login.phase).toBe("working");

      surface.cancelLogin();
      await warming;

      expect(aborted).toBe(true);
      expect((await surface.snapshot()).login.phase).toBe("idle");
      expect((await loadConfigFile(configPath)).model).toBeUndefined();
    });
  });

  test("failed local warmup leaves the prior selection untouched", async () => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      await withHome(async ({ root, surface: make, local }) => {
        await local([{ alias: "one" }, { alias: "two" }]);
        const configPath = path.join(root, "local.toml");
        const surface = await make({
          configPath,
          prepareModel: async () => {
            throw new Error("Atomic could not load the model.");
          },
        });

        await surface.startLogin("This computer");
        await surface.pickLocalModel({
          model: "llama.cpp/one",
          contextTokens: 65_536,
          reasoningTokens: 1_024,
          reasoning: "high",
        });
        expect((await surface.snapshot()).login).toEqual({
          phase: "error",
          message:
            "Could not wake the Game Master. Check the Model and try again.\nAtomic could not load the model.",
        });
        expect(stderr).toHaveBeenCalledWith(
          "Game Master load failed: Atomic could not load the model.",
        );
        expect((await loadConfigFile(configPath)).model).toBeUndefined();
      });
    } finally {
      stderr.mockRestore();
    }
  });

  test("connected Provider skips login and only loads models", async () => {
    await withHome(async ({ provider, surface: make }) => {
      await provider.connect();
      const surface = await make();
      await surface.startLogin("Lanternlight");
      const snap = await surface.snapshot();
      expect(provider.seen.auth).toEqual([]);
      expect(provider.signIns).toEqual([]);
      expect(snap.login.phase).toBe("awaiting_model");
      expect(snap.signedIn?.provider).toBe(provider.id);
      expect(snap.models?.map((m) => m.name)).toEqual(["Lamp 2", "Lamp 1"]);
      expect(
        snap.providers.more.find((p) => p.name === "Lanternlight")?.connected,
      ).toBe(true);
    });
  });

  test("cancelling an early local Campaign open prevents later model startup", async () => {
    await withHome(async ({ root, surface: make }) => {
      await writePack(path.join(root, "packs", "brinewatch"), {
        "seed.md": "# Brinewatch\n",
        "player_sheet.md": "## Description\nRen Caldew.\n",
      });
      const initial = await make({
        config: mergeConfig({ model: "xai-oauth/grok-4.6" }, {}),
      });
      const campaign = await initial.birthAndOpen("brinewatch", "Dock Nights");
      await initial.leave();

      let prepareCalls = 0;
      const local = await make({
        config: mergeConfig({ model: "llama.cpp/slow-model" }, {}),
        prepareModel: async () => {
          prepareCalls += 1;
        },
      });

      const opening = local.openById(campaign.id);
      local.cancelLogin();

      await expect(opening).rejects.toMatchObject({ name: "HomeError" });
      expect(prepareCalls).toBe(0);
      expect((await local.snapshot()).open).toBeNull();
    });
  });

  test("New births a library Campaign and Continue lists it by name", async () => {
    await withHome(async ({ root, surface: make }) => {
      await writePack(path.join(root, "packs", "brinewatch"), {
        "seed.md":
          "# Brinewatch\n\n## Opening message\n\nMira Venn watches you.\n",
        "player_sheet.md": "## Description\nRen Caldew.\n",
        "pack.yaml": "name: Brinewatch\ndescription: Salt dock.\n",
      });
      const surface = await make();
      const open = await surface.birthAndOpen("brinewatch", "Dock Nights");
      expect(open.name).toBe("Dock Nights");
      expect(open.path.startsWith(path.join(root, "campaigns"))).toBe(true);
      expect((await surface.snapshot()).locked).toBe(true);
      await expect(surface.startLogin("Lanternlight")).rejects.toMatchObject({
        code: "busy",
      });
      await surface.leave();
      const snap = await surface.snapshot();
      expect(snap.campaigns.map((c) => c.name)).toEqual(["Dock Nights"]);
      expect(snap.open).toBeNull();
      expect(snap.locked).toBe(false);
      void surface.startLogin("Lanternlight");
      await waitForLoginPhase(surface, "awaiting_prompt");
      surface.cancelLogin();

      await unlink(path.join(open.path, SEED_MD));
      await expect(surface.openById(open.id)).rejects.toMatchObject({
        name: "HomeError",
        message: "Could not open that adventure.",
      });
    });
  });
});

describe("Home local model reuse", () => {
  test("resuming after loading a local model keeps the engine the dialog started", async () => {
    const root = await makeTempDir();
    // a real Local Inference Host in NQ's default root over a fake llama-server
    const host = await startLocalHost({ defaultRoot: true });
    try {
      const campaign = await birthCampaign(path.join(root, "campaigns"), {
        name: "Dock Nights",
        seed: "# Brinewatch\n\n## Opening message\n\nMira Venn watches you.\n",
      });
      const configPath = path.join(root, "config.toml");
      const surface = new HomeSurface({
        config: mergeConfig({}, {}),
        configPath,
        packsDir: path.join(root, "packs"),
        campaignsDir: path.join(root, "campaigns"),
        factory: await host.gameMaster(),
        prepareModel: host.prepareModel,
      });
      await surface.refreshLocal();
      await surface.startLogin("This computer");
      // the dialog sends the knobs it remembers, not just what config holds
      await surface.pickLocalModel({
        model: `llama.cpp/${host.alias}`,
        contextTokens: 16_384,
        reasoningTokens: 2_000,
        reasoning: "medium",
        cacheK: "q8_0",
        cacheV: "q8_0",
        kvOffload: false,
        tuning: { temperature: 0.7, topK: 20 },
      });
      expect(host.engine.spawns).toHaveLength(1);

      await surface.openPath(campaign);
      expect(host.engine.spawns).toHaveLength(1);
      await surface.leave();

      // and the choice outlives this Home: a fresh one reads the same profile
      const saved = await loadConfigFile(configPath);
      expect(saved.localKvOffload).toBe(false);
      expect(saved.localTuning).toMatchObject({ temperature: 0.7, topK: 20 });
    } finally {
      await host.stop();
      await rmTempDir(root);
    }
  });
});
