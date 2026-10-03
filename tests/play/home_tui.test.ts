import type { TestRendererSetup } from "@opentui/core/testing";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfigFile, mergeConfig } from "../../src/config.ts";
import { HomeSurface } from "../../src/home/index.ts";
import { birthLibraryCampaign } from "../../src/home/library.ts";
import { makeTempDir, rmTempDir, writePack } from "../helpers/fs.ts";
import { scriptedGameMaster } from "../helpers/game_master.ts";
import { fakeProvider, installLocalModels } from "../helpers/home.ts";
import { startLocalHost, writeDeviceScript } from "../helpers/local_host.ts";

/**
 * The terminal Home over the real Home app: real HomeSurface, NQ's Home auth
 * adapter over OMP's real auth store and model registry, real Campaign
 * folders, a real local runtime installation with GGUF files, the real Home
 * settings, profile and Almanac files beside a temp config, and OpenTUI's test
 * renderer standing in for the terminal. Faked: the Provider's sign-in, the
 * Game Master's model, and the local engine (its warm-up, or a fake engine
 * behind a real Local Inference Host).
 */

const GIB = 1024 ** 3;

/**
 * Render until a frame satisfies `ok`. The test renderer counts passes, not
 * time, and Home attaches its tree asynchronously, so give it a time budget.
 */
async function frameMatching(
  setup: { renderOnce: () => Promise<void>; captureCharFrame: () => string },
  ok: (frame: string) => boolean,
  timeoutMs = 4_000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (ok(frame)) return frame;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`no matching frame; last frame:\n${frame}`);
    }
    await Bun.sleep(5);
  }
}

/** Wait for a frame showing `text`. */
function showing(setup: TestRendererSetup, text: string, timeoutMs?: number): Promise<string> {
  return frameMatching(setup, (frame) => frame.includes(text), timeoutMs);
}

/** The list row under the cursor. */
function cursorLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("▶")) ?? "";
}

/** Move the list cursor down to the row whose text includes `label`. */
async function moveTo(setup: TestRendererSetup, label: string): Promise<void> {
  let frame = "";
  for (let i = 0; i < 80; i++) {
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    if (cursorLine(frame).includes(label)) return;
    setup.mockInput.pressArrow("down");
  }
  throw new Error(`the cursor never reached "${label}"; last frame:\n${frame}`);
}

/** Choose the row whose text includes `label`. */
async function pick(setup: TestRendererSetup, label: string): Promise<void> {
  await moveTo(setup, label);
  setup.mockInput.pressEnter();
}

/** Choose a field, clear its line, type `text` and set it. */
async function typeInto(setup: TestRendererSetup, label: string, text: string): Promise<void> {
  await pick(setup, label);
  await showing(setup, "Ctrl+U clear");
  setup.mockInput.pressKey("u", { ctrl: true });
  await setup.mockInput.typeText(text);
  setup.mockInput.pressEnter();
}

/** Choose a field, then one of its choices. */
async function choose(setup: TestRendererSetup, label: string, choice: string): Promise<void> {
  await pick(setup, label);
  await showing(setup, "Enter choose");
  await pick(setup, choice);
}

type TerminalHome = {
  root: string;
  configPath: string;
  setup: TestRendererSetup;
  surface: HomeSurface;
  provider: Awaited<ReturnType<typeof fakeProvider>>;
  local: Awaited<ReturnType<typeof installLocalModels>>;
  host?: Awaited<ReturnType<typeof startLocalHost>>;
};

async function withTerminalHome(
  opts: {
    config?: Parameters<typeof mergeConfig>[0];
    local?: Parameters<typeof installLocalModels>[0];
    prepareModel?: ConstructorParameters<typeof HomeSurface>[0]["prepareModel"];
    /** A real Local Inference Host over a fake engine, warmed as `nq play` does. */
    host?: Parameters<typeof startLocalHost>[0];
    /** One fixed Game Master on the fake Provider, as the hosted book has. */
    gameMaster?: { provider: string; name: string };
    fixedSettings?: ConstructorParameters<typeof HomeSurface>[0]["fixedSettings"];
    size?: { width: number; height: number };
  },
  run: (ctx: TerminalHome) => Promise<void>,
): Promise<void> {
  const root = await makeTempDir();
  let setup: TestRendererSetup;
  try {
    const { createTestRenderer } = await import("@opentui/core/testing");
    setup = await createTestRenderer(opts.size ?? { width: 70, height: 24 });
  } catch (err) {
    console.warn("OpenTUI native test renderer unavailable:", err);
    await rmTempDir(root);
    return;
  }
  const provider = await fakeProvider();
  const local = await installLocalModels(opts.local ?? []);
  // the host installs its model where NQ looks for one, over the empty install
  const host = opts.host
    ? await startLocalHost({ ...opts.host, defaultRoot: true })
    : undefined;
  const configPath = path.join(root, "config.toml");
  const surface = new HomeSurface({
    config: mergeConfig(opts.config ?? {}, {}),
    configPath,
    packsDir: path.join(root, "packs"),
    campaignsDir: path.join(root, "campaigns"),
    factory: (await scriptedGameMaster()).factory,
    auth: provider.auth,
    ...(opts.prepareModel ? { prepareModel: opts.prepareModel } : {}),
    ...(host ? { prepareModel: host.prepareModel } : {}),
    ...(opts.gameMaster
      ? { gameMaster: { ...opts.gameMaster, model: `${provider.id}/lamp-2` } }
      : {}),
    ...(opts.fixedSettings ? { fixedSettings: opts.fixedSettings } : {}),
  });
  try {
    await writePack(path.join(root, "packs", "brinewatch"), {
      "seed.md":
        "# Brinewatch\n\n## Opening message\n\nMira Venn watches you.\n",
      "player_sheet.md": "## Description\nRen.\n",
      "pack.yaml": "name: Brinewatch\ndescription: Salt dock.\n",
    });
    await run({ root, configPath, setup, surface, provider, local, host });
  } finally {
    await surface.leave();
    setup.renderer.destroy();
    await host?.stop();
    await local.remove();
    provider.dispose();
    await rmTempDir(root);
  }
}

describe("OpenTUI Home", () => {
  test("navigates Home and confirms Campaign deletion", async () => {
    await withTerminalHome({}, async ({ root, setup, surface }) => {
      const campaign = await birthLibraryCampaign({
        packDir: path.join(root, "packs", "brinewatch"),
        title: "Dock Nights",
        campaignsDir: path.join(root, "campaigns"),
        id: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      });
      const { runHomeTui } = await import("../../src/surfaces/tui/home.ts");
      const running = runHomeTui(setup.renderer, surface);
      const frame = await frameMatching(setup, (next) =>
        next.includes("New adventure"),
      );
      expect(frame).toContain("Neverending Quest");
      expect(frame).toContain("Sign in");
      expect(frame).toContain("Continue");
      expect(frame).toContain("1 Campaign");
      expect(frame).not.toMatch(/fredicus|xai-oauth|auth-broker/i);
      setup.mockInput.pressArrow("down");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await frameMatching(setup, (next) => next.includes("D delete"));
      setup.renderer.keyInput.emit("keypress", { name: "d" } as never);
      const warning = await frameMatching(setup, (next) =>
        next.includes('Delete "Dock Nights"?'),
      );
      expect(warning).toContain('Delete "Dock Nights"?');
      expect(
        await Bun.file(path.join(campaign.path, "campaign.yaml")).exists(),
      ).toBe(true);

      setup.mockInput.pressEnter();
      const after = await frameMatching(setup, (next) =>
        next.includes("(none yet)"),
      );
      expect(
        await Bun.file(path.join(campaign.path, "campaign.yaml")).exists(),
      ).toBe(false);
      expect(after).toContain("(none yet)");
      expect(after).toContain("Start a new adventure");

      setup.mockInput.pressEscape();
      await frameMatching(setup, (next) => next.includes("No Campaigns yet"));
      setup.mockInput.pressEscape();
      expect(await running).toBe("quit");
    });
  });

  test("signs in, finds a model, picks its thinking level, and begins an adventure", async () => {
    await withTerminalHome({}, async ({ root, setup, surface, provider }) => {
      const { runHomeTui } = await import("../../src/surfaces/tui/home.ts");
      const running = runHomeTui(setup.renderer, surface);
      await frameMatching(setup, (next) => next.includes("New adventure"));

      // Sign in → More… → the Provider (OMP's real list, alphabetical)
      setup.mockInput.pressEnter();
      const providers = await frameMatching(setup, (next) =>
        next.includes("More…"),
      );
      expect(providers).toContain("Grok");
      expect(providers).not.toContain("This computer");
      const snap = await surface.snapshot();
      for (let i = 0; i < snap.providers.featured.length; i++) {
        setup.mockInput.pressArrow("down");
      }
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      const index = snap.providers.more.findIndex(
        (p) => p.name === "Lanternlight",
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const first = snap.providers.more[0]!.name;
      await frameMatching(setup, (next) => next.includes(first));
      for (let i = 0; i < index; i++) setup.mockInput.pressArrow("down");
      await setup.renderOnce();
      setup.mockInput.pressEnter();

      // the Provider asks for a key, in player words
      const prompt = await frameMatching(setup, (next) =>
        next.includes("Paste your key."),
      );
      expect(prompt).not.toMatch(/OAuth|config\.toml|auth-broker/i);
      await setup.mockInput.typeText("sk-terminal");
      setup.mockInput.pressEnter();

      const models = await frameMatching(setup, (next) =>
        next.includes("Lamp 1"),
      );
      expect(models).toContain("Lamp 2");
      expect(provider.signIns).toEqual(["sk-terminal"]);
      await setup.mockInput.typeText("lamp 2");
      await frameMatching(setup, (next) => !next.includes("Lamp 1"));
      setup.mockInput.pressEnter();

      const levels = await frameMatching(setup, (next) =>
        next.includes("Extra high"),
      );
      expect(levels).toContain("Medium");
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressArrow("down");
      await setup.renderOnce();
      setup.mockInput.pressEnter();

      await frameMatching(setup, (next) => next.includes("Accounts"));
      const saved = await loadConfigFile(path.join(root, "config.toml"));
      expect(saved.model).toBe(`${provider.id}/lamp-2`);
      expect(saved.reasoning).toBe("high");

      // New adventure → the Seed Pack → keep its name as the title
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressArrow("down");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await frameMatching(setup, (next) => next.includes("Salt dock."));
      setup.mockInput.pressEnter();
      await frameMatching(setup, (next) => next.includes("Enter confirm"));
      setup.mockInput.pressEnter();

      expect(await running).toBe("opened");
      expect(surface.play).not.toBeNull();
      const open = (await surface.snapshot()).open;
      expect(open?.name).toBe("Brinewatch");
      expect(
        await Bun.file(path.join(open!.path, "campaign.yaml")).exists(),
      ).toBe(true);
      expect(open!.path.startsWith(path.join(root, "campaigns"))).toBe(true);
    });
  });
});

describe("OpenTUI Home: This computer", () => {
  test("a refused context, every engine choice, a cancelled warm-up, and a reload on the remembered choices", async () => {
    const warmups: Array<Record<string, unknown>> = [];
    let hold: PromiseWithResolvers<void> | undefined;
    await withTerminalHome(
      {
        local: [
          { alias: "first", size: 12 * GIB },
          { alias: "second", size: 24 * GIB },
        ],
        size: { width: 100, height: 70 },
        // the engine warm-up is external; the first one hangs until cancelled
        prepareModel: async (model, opts) => {
          warmups.push({
            model,
            contextTokens: opts.contextTokens,
            reasoningTokens: opts.reasoningTokens,
            cacheV: opts.cacheV,
            reasoning: opts.reasoning,
            temperature: opts.tuning?.temperature,
          });
          if (!hold) return;
          opts.onProgress("Loading the model onto the card…");
          await new Promise<void>((resolve, reject) => {
            opts.signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
              { once: true },
            );
            hold!.promise.then(resolve);
          });
        },
      },
      async ({ setup, surface, configPath, local }) => {
        const projector = await local.addProjector("mmproj-seer.gguf");
        const { runHomeTui } = await import("../../src/surfaces/tui/home.ts");
        const running = runHomeTui(setup.renderer, surface);
        const hub = await showing(setup, "New adventure");
        // the Almanac is about local models, so it shows once one is installed
        expect(hub).toContain("Almanac");

        await pick(setup, "Sign in");
        await pick(setup, "This computer");
        let page = await showing(setup, "Choose the model and how much memory it may use.");
        expect(page).toContain("Model: first");
        expect(page).toContain("New here: NQ suggests where this model runs");
        expect(page).toContain("Reasoning budget: -1 tokens");
        expect(page).toContain("Vision projector: None");

        await pick(setup, "Model: first");
        const models = await showing(setup, "Enter choose");
        expect(models).toContain("12.0 GiB");
        expect(models).toContain("24.0 GiB");
        await pick(setup, "second");
        await showing(setup, "Model: second");

        // the surface checks the profile; its refusal keeps the page open
        await typeInto(setup, "Context window", "0");
        await showing(setup, "Context window: 0 tokens");
        await pick(setup, "Load Game Master");
        await showing(setup, "Context size must be a positive whole number.");
        expect(warmups).toHaveLength(0);

        await typeInto(setup, "Context window", "32768");
        await showing(setup, "Context window: 32768 tokens");
        await typeInto(setup, "Reasoning budget", "2048");
        await showing(setup, "Reasoning budget: 2048 tokens");
        await choose(setup, "Thinking level", "high");
        await showing(setup, "Thinking level: high");
        await choose(setup, "Value cache", "turbo2");
        await showing(setup, "Value cache: turbo2");
        await choose(setup, "Vision projector", "mmproj-seer");
        await showing(setup, "Vision projector: mmproj-seer");

        // the temperament: Auto's values, with one of the player's own over them
        await pick(setup, "Temperament:");
        const sampling = await showing(setup, "Type over any value to use your own.");
        expect(sampling).toContain("Temperature:");
        await typeInto(setup, "Temperature", "0.7");
        await showing(setup, "Temperature: 0.7");
        await pick(setup, "Back to This computer");
        page = await showing(setup, "1 of yours");

        // first attempt: the warm-up hangs; Home waits on it until cancelled
        hold = Promise.withResolvers<void>();
        await pick(setup, "Load Game Master");
        const loading = await showing(setup, "Loading local Game Master");
        expect(loading).toContain("Home will stay locked until the Game Master is ready.");
        await showing(setup, "Loading the model onto the card…");
        expect(warmups).toHaveLength(1);
        setup.mockInput.pressEscape();
        await showing(setup, "New adventure");
        expect((await loadConfigFile(configPath)).model).toBeUndefined();
        hold = undefined;

        // reopen: the model's saved profile and this sitting's choices are back
        await pick(setup, "Accounts");
        await pick(setup, "This computer");
        page = await showing(setup, "Choose the model and how much memory it may use.");
        expect(page).toContain("Model: second");
        expect(page).toContain("Loads with the engine settings you last used for this model.");
        expect(page).toContain("Context window: 32768 tokens");
        expect(page).toContain("Value cache: turbo2");
        expect(page).toContain("Thinking level: high");
        expect(page).toContain("Vision projector: mmproj-seer");
        await pick(setup, "Load Game Master");

        await showing(setup, "Signed in: This computer");
        expect(warmups[1]).toEqual({
          model: "llama.cpp/second",
          contextTokens: 32_768,
          reasoningTokens: 2_048,
          cacheV: "turbo2",
          reasoning: "high",
          temperature: 0.7,
        });
        const saved = await loadConfigFile(configPath);
        expect(saved.model).toBe("llama.cpp/second");
        expect(saved.reasoning).toBe("high");
        expect(saved.localContextTokens).toBe(32_768);
        expect(saved.localCacheV).toBe("turbo2");
        expect(saved.localTuning?.temperature).toBe(0.7);
        const installation = JSON.parse(
          await readFile(path.join(local.rootDir, "installation.json"), "utf8"),
        ) as { models: Array<{ alias: string; mmproj?: { path: string } }> };
        expect(installation.models.find((m) => m.alias === "second")?.mmproj?.path).toBe(
          projector,
        );
        setup.mockInput.pressEscape();
        expect(await running).toBe("quit");
      },
    );
  });

  test("download the Vulkan engine, pick the Arc, and run the Game Master on it", async () => {
    const nvidia = "NVIDIA GeForce RTX 3080 Ti";
    const arc = "Intel(R) Arc(TM) Pro B70 Graphics";
    await withTerminalHome(
      {
        size: { width: 100, height: 70 },
        host: {
          backend: "cuda-12.4",
          devices: `Available devices:\n  CUDA0: ${nvidia} (12136 MiB, 11421 MiB free)\n`,
        },
      },
      async ({ root, setup, surface, configPath, host }) => {
        // Atomic's GitHub release is remote: a real archive of an engine that
        // sees both cards, which NQ downloads, verifies and extracts for real
        const { DEFAULT_ATOMIC_RELEASE } = await import("@nq/local-inference/runtime.ts");
        const staging = path.join(root, "vulkan-release");
        await writeDeviceScript(
          path.join(staging, "build", "bin", "llama-server"),
          "Available devices:\n" +
            `  Vulkan0: ${nvidia} (12288 MiB, 11000 MiB free)\n` +
            `  Vulkan1: ${arc} (32656 MiB, 32000 MiB free)\n`,
        );
        const archive = path.join(root, "vulkan.tar.gz");
        await Bun.$`tar -czf ${archive} -C ${staging} build`.quiet();
        const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
        const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        const routed = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.startsWith("https://api.github.com/repos/AtomicBot-ai/")) {
            if (!url.endsWith(`/tags/${DEFAULT_ATOMIC_RELEASE}`)) {
              return Response.json({ message: "Not Found" }, { status: 404 });
            }
            return Response.json({
              assets: [
                {
                  name: "llama-turboquant-linux-x64-vulkan.tar.gz",
                  browser_download_url: "https://downloads.test/vulkan.tar.gz",
                  digest: `sha256:${digest}`,
                  size: bytes.byteLength,
                },
              ],
            });
          }
          if (url === "https://downloads.test/vulkan.tar.gz") return new Response(bytes);
          return routed(input, init);
        }) as typeof fetch;
        try {
          const { runHomeTui } = await import("../../src/surfaces/tui/home.ts");
          const running = runHomeTui(setup.renderer, surface);
          await showing(setup, "New adventure");
          await pick(setup, "Sign in");
          await pick(setup, "This computer");
          let page = await showing(setup, "GPU: Automatic");
          expect(page).toContain("[ ] Turn off flash attention");

          // the installed CUDA build reaches only the NVIDIA card
          await pick(setup, "GPU: Automatic");
          let cards = await showing(setup, "Enter choose");
          expect(cards).toContain(`${nvidia} — CUDA, 11.9 GiB`);
          expect(cards).not.toContain(arc);
          setup.mockInput.pressEscape();
          await showing(setup, "GPU: Automatic");

          await pick(setup, "Find more GPUs with Vulkan");
          page = await frameMatching(
            setup,
            (frame) =>
              !frame.includes("GPUs with Vulkan") &&
              !frame.includes("Downloading the Vulkan engine") &&
              frame.includes("GPU: Automatic"),
            15_000,
          );
          await pick(setup, "GPU: Automatic");
          cards = await showing(setup, `${arc} — Vulkan, 31.9 GiB`);
          expect(cards).toContain(`${nvidia} — Vulkan, 12.0 GiB`);
          await pick(setup, arc);

          // flash attention crawls on Intel's Vulkan driver, so picking the
          // Arc turns it off, and both caches go to f16
          page = await showing(setup, `GPU: ${arc}`);
          expect(page).toContain("[x] Turn off flash attention");
          expect(page).toContain("Key cache: f16");
          expect(page).toContain("Value cache: f16");
          await pick(setup, "Keep the cache in system RAM");
          await showing(setup, "[x] Keep the cache in system RAM");
          await pick(setup, "Load Game Master");

          // the Vulkan build launches, pinned to the Arc by the number it gave it
          await showing(setup, "Signed in: This computer", 15_000);
          expect(host!.engine.spawns).toHaveLength(1);
          expect(host!.engine.commands[0]).toBe(
            path.join(host!.rootDir, "runtime", DEFAULT_ATOMIC_RELEASE, "vulkan", "build", "bin", "llama-server"),
          );
          const args = host!.engine.spawns[0]!;
          expect(args[args.indexOf("--device") + 1]).toBe("Vulkan1");
          expect(args[args.indexOf("-fa") + 1]).toBe("off");
          expect(args[args.indexOf("-ctk") + 1]).toBe("f16");
          expect(args).toContain("--no-kv-offload");
          const saved = await loadConfigFile(configPath);
          expect(saved.localGpu).toEqual({ backend: "vulkan", device: "Vulkan1", name: arc });
          expect(saved.localFlashAttention).toBe(false);
          expect(saved.localKvOffload).toBe(false);
          setup.mockInput.pressEscape();
          expect(await running).toBe("quit");
        } finally {
          globalThis.fetch = routed;
        }
      },
    );
  });
});

describe("OpenTUI Home: Settings", () => {
  test("edits the settings, shows the surface's refusal, and saves to the config file", async () => {
    // a local Game Master, so the local fields are part of Settings
    await withTerminalHome(
      { config: { model: "llama.cpp/slow-model" }, size: { width: 100, height: 60 } },
      async ({ setup, surface, configPath }) => {
        const { runHomeTui } = await import("../../src/surfaces/tui/home.ts");
        const running = runHomeTui(setup.renderer, surface);
        await showing(setup, "New adventure");
        await pick(setup, "Settings");
        const settings = await showing(setup, "Changes apply to the next adventure you open.");
        expect(settings).toContain("Turn inactivity timeout: 180 seconds");
        expect(settings).toContain("Reasoning budget: -1 tokens");
        expect(settings).toContain("Rebuild seed ceiling: 50 % of ceiling");
        expect(settings).toContain("Local thinking opener");
        expect(settings).toContain("Model: llama.cpp/slow-model");

        await typeInto(setup, "Turn inactivity timeout", "900");
        await showing(setup, "Turn inactivity timeout: 900 seconds");
        await typeInto(setup, "Light hygiene every", "0");
        await typeInto(setup, "Reasoning budget", "2048");
        await typeInto(setup, "GM personality", "Patient, severe, and attentive to old grudges.");
        await showing(setup, "GM personality: Patient, severe");
        await pick(setup, "Save settings");
        await showing(setup, "hygieneN must be between 1 and 10000.");
        expect(await Bun.file(configPath).exists()).toBe(false);

        await typeInto(setup, "Light hygiene every", "5");
        await showing(setup, "Light hygiene every: 5 turns");
        await pick(setup, "Save settings");
        await showing(setup, "New adventure");
        const file = await Bun.file(configPath).text();
        expect(file).toContain("timeout = 900");
        expect(file).toContain("Patient, severe, and attentive to old grudges.");
        expect(surface.config.turnTimeoutMs).toBe(900_000);
        const saved = await loadConfigFile(configPath);
        expect(saved.hygieneN).toBe(5);
        expect(saved.localReasoningTokens).toBe(2_048);
        setup.mockInput.pressEscape();
        expect(await running).toBe("quit");
      },
    );
  });

  test("a book with one Game Master hides sign-in and the settings it fixes", async () => {
    await withTerminalHome(
      {
        gameMaster: { provider: "Neverending Quest", name: "Lamp" },
        fixedSettings: { compactCeilingTokens: 100_000 },
        size: { width: 100, height: 60 },
      },
      async ({ setup, surface }) => {
        const { runHomeTui } = await import("../../src/surfaces/tui/home.ts");
        const running = runHomeTui(setup.renderer, surface);
        const hub = await showing(setup, "New adventure");
        expect(hub).toContain("Signed in: Neverending Quest");
        expect(hub).not.toMatch(/^\s+(▶ )?Sign in\s*$/m);
        expect(hub).not.toContain("Accounts");
        await pick(setup, "Settings");
        const settings = await showing(setup, "Turn inactivity timeout");
        expect(settings).not.toContain("Model:");
        expect(settings).not.toContain("Context ceiling");
        expect(settings).not.toContain("Local thinking opener");
        setup.mockInput.pressEscape();
        await showing(setup, "New adventure");
        setup.mockInput.pressEscape();
        expect(await running).toBe("quit");
      },
    );
  });
});

describe("OpenTUI Home: the Almanac", () => {
  test("copies a book entry into the player's hand, refuses an incomplete one, edits it, and tears it out", async () => {
    await withTerminalHome(
      {
        local: [
          {
            alias: "lucent-witch-31b.i1-iq3_xxs",
            architecture: "gemma4",
            metadata: {
              "general.base_model.count": 1,
              "general.base_model.0.name": "Gemma 4 31B It",
            },
          },
        ],
        size: { width: 100, height: 70 },
      },
      async ({ setup, surface, configPath }) => {
        const { loadAlmanac } = await import("@nq/local-inference/almanac_store.ts");
        const { runHomeTui } = await import("../../src/surfaces/tui/home.ts");
        const running = runHomeTui(setup.renderer, surface);
        await showing(setup, "New adventure");
        await pick(setup, "Almanac");
        await showing(setup, "In your hand: nothing written here yet.");

        // find the family, recognised through the model's base model
        await setup.mockInput.typeText("gemma 4");
        await frameMatching(setup, (frame) => !frame.includes("Qwen"));
        await pick(setup, "Gemma 4");
        let entry = await showing(setup, "Catches your models:");
        expect(entry).toContain("Google");
        expect(entry).toContain("✓ lucent-witch-31b");

        await pick(setup, "Copy into your hand");
        await showing(setup, "Title: Gemma 4 (yours)");
        await typeInto(setup, "Title", "Witch at 1.3");
        await typeInto(setup, "Names like", "*lucent-witch*");
        await pick(setup, "Temperature:");
        await showing(setup, "Leave a value blank");
        await typeInto(setup, "Always", "1.3");
        await showing(setup, "Always: 1.3");
        await pick(setup, "Done");
        await showing(setup, "Temperature: 1.3 / — / —");
        await pick(setup, "Write it down");
        entry = await showing(setup, "In your hand");
        expect(entry).toContain("Witch at 1.3");
        expect(await loadAlmanac(configPath)).toEqual([
          {
            id: "yours-witch-at-1.3",
            title: "Witch at 1.3",
            source: "yours",
            match: { names: ["*lucent-witch*"], architecture: ["gemma4"] },
            extends: "gemma-4",
            values: { temperature: 1.3 },
          },
        ]);

        // a new entry needs a title, and something to recognise or build on
        await pick(setup, "‹ All entries");
        // the index kept its search; clear it to see the player's entry first
        await showing(setup, "Type to find");
        setup.mockInput.pressKey("u", { ctrl: true });
        const index = await showing(setup, "✎ Witch at 1.3");
        expect(index.indexOf("✎ Witch at 1.3")).toBeLessThan(index.indexOf("Gemma 4"));
        expect(index).toContain("In your hand · Temp 1.3 · 1 of yours");
        await pick(setup, "Write a new entry");
        await showing(setup, "A new entry");
        await pick(setup, "Write it down");
        await showing(setup, "Give the entry a title.");
        await typeInto(setup, "Title", "Loose page");
        await pick(setup, "Write it down");
        await showing(setup, "Say which models the entry is for, or what it is built on.");
        await pick(setup, "Cancel");

        // edit the player's own entry
        await pick(setup, "✎ Witch at 1.3");
        await pick(setup, "Edit this entry");
        await showing(setup, "Editing your entry");
        await typeInto(setup, "Title", "Witch at 1.4");
        await pick(setup, "Temperature:");
        await typeInto(setup, "Always", "1.4");
        await pick(setup, "Done");
        await pick(setup, "Write it down");
        entry = await showing(setup, "Tear out…");
        expect(entry).toContain("Witch at 1.4");
        expect(await loadAlmanac(configPath)).toEqual([
          expect.objectContaining({
            id: "yours-witch-at-1.3",
            title: "Witch at 1.4",
            values: { temperature: 1.4 },
          }),
        ]);

        await pick(setup, "Tear out…");
        await showing(setup, "Tear this page out of the Almanac?");
        await pick(setup, "Tear it out");
        await showing(setup, "In your hand: nothing written here yet.");
        expect(await loadAlmanac(configPath)).toEqual([]);
        setup.mockInput.pressEscape();
        await showing(setup, "New adventure");
        setup.mockInput.pressEscape();
        expect(await running).toBe("quit");
      },
    );
  });
});
