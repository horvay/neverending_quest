/**
 * The web Home as a player uses it: the real `<Root />` with no Campaign open,
 * over the real Home app (homeHttpApp + serveHttpApp, a real HomeSurface, NQ's
 * Home auth adapter over OMP's real auth store and model registry, a real
 * local runtime installation with GGUF files, real Campaign folders on disk).
 *
 * Faked: the Provider's sign-in and catalog (registered like an OMP
 * extension), the local engine's warm-up, and the Game Master's model.
 */
import {
  installDom,
  installHandlerFetch,
  preferReducedMotion,
  serveHome,
} from "./dom_setup.ts";

installDom();

const { afterEach, describe, expect, test } = await import("bun:test");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/preact");
const userEvent = (await import("@testing-library/user-event")).default;
const { chmod, readFile, rm, truncate } = await import("node:fs/promises");
const path = (await import("node:path")).default;
const { loadConfigFile, mergeConfig } = await import("../../src/config.ts");
const { HomeSurface } = await import("../../src/home/index.ts");
const { birthLibraryCampaign } = await import("../../src/home/library.ts");
const { Root } = await import("../../src/surfaces/web/client/client.tsx");
const { makeTempDir, rmTempDir, writePack } = await import("../helpers/fs.ts");
const { scriptedGameMaster, says } = await import("../helpers/game_master.ts");
const { fakeProvider, installLocalModels } = await import("../helpers/home.ts");
const { startLocalHost, writeDeviceScript } = await import(
  "../helpers/local_host.ts"
);
const { fakeExl3xpuRegistry } = await import("../helpers/exl3_registry.ts");
const { writeGgufFixture } = await import("../helpers/gguf.ts");

preferReducedMotion();

afterEach(() => {
  cleanup();
  // the local panel remembers its last selection in the browser
  globalThis.localStorage?.clear();
});

const GIB = 1024 ** 3;

// In happy-dom, never hand a DOM node to `expect` inside `waitFor`: a failing
// check pretty-prints the whole DOM, costs seconds per attempt, and stalls the
// app under test. Assertions below compare with `=== null` instead.

type Booted = {
  root: string;
  surface: InstanceType<typeof HomeSurface>;
  provider: Awaited<ReturnType<typeof fakeProvider>>;
  local: Awaited<ReturnType<typeof installLocalModels>>;
  /** A real Local Inference Host over a fake engine, when asked for. */
  host?: Awaited<ReturnType<typeof startLocalHost>>;
  configPath: string;
  campaignsDir: string;
};

/** Boot the real Home app for one test and tear it all down afterwards. */
async function withWebHome(
  opts: {
    config?: Parameters<typeof mergeConfig>[0];
    /** A config file on disk, read the way `nq serve` reads it. */
    configToml?: string;
    models?: NonNullable<Parameters<typeof fakeProvider>[0]>["models"];
    local?: Parameters<typeof installLocalModels>[0];
    prepareModel?: ConstructorParameters<typeof HomeSurface>[0]["prepareModel"];
    /**
     * Install one model behind a real Local Inference Host whose engine is
     * faked, and warm it the way `nq serve` does. Replaces `local`.
     */
    host?: Parameters<typeof startLocalHost>[0];
  },
  run: (ctx: Booted) => Promise<void>,
): Promise<void> {
  const root = await makeTempDir();
  const provider = await fakeProvider(
    opts.models ? { models: opts.models } : {},
  );
  const local = await installLocalModels(opts.local ?? []);
  // the host installs its model where NQ looks for one, over the empty install
  const host = opts.host
    ? await startLocalHost({ ...opts.host, defaultRoot: true })
    : undefined;
  const configPath = path.join(root, "config.toml");
  if (opts.configToml !== undefined) await Bun.write(configPath, opts.configToml);
  const fileConfig =
    opts.configToml !== undefined ? await loadConfigFile(configPath) : {};
  const campaignsDir = path.join(root, "campaigns");
  await writePack(path.join(root, "packs", "brinewatch"), {
    "seed.md":
      "# Brinewatch\n\n## Opening message\n\nMira Venn watches you from the Salt Lamp doorway.\n",
    "player_sheet.md": "## Description\nRen Caldew.\n",
    "pack.yaml": "name: Brinewatch\ndescription: Salt dock sandbox.\n",
  });
  const gm = await scriptedGameMaster({ fallback: says("Mira nods.") });
  const surface = new HomeSurface({
    config: mergeConfig({ ...fileConfig, ...opts.config }, {}),
    configPath,
    packsDir: path.join(root, "packs"),
    campaignsDir,
    factory: gm.factory,
    auth: provider.auth,
    // the browser is external; nothing should need it here
    openBrowser: async () => {},
    ...(opts.prepareModel ? { prepareModel: opts.prepareModel } : {}),
    ...(host ? { prepareModel: host.prepareModel } : {}),
  });
  const web = await serveHome(surface);
  const restoreFetch = installHandlerFetch(web.handler);
  try {
    await run({ root, surface, provider, local, host, configPath, campaignsDir });
  } finally {
    cleanup();
    restoreFetch();
    await web.close();
    await host?.stop();
    await local.remove();
    provider.dispose();
    await chmod(campaignsDir, 0o755).catch(() => {});
    await rmTempDir(root);
  }
}

describe("web Home over the real Home app", () => {
  test("signs in with a pasted key, finds a model, picks thinking, and begins an adventure", async () => {
    const models = [
      {
        id: "lamp-2",
        name: "Lamp 2",
        efforts: ["low", "medium", "high"] as const,
      },
      { id: "lamp-2-free", name: "Lamp 2 (free)" },
      ...Array.from({ length: 28 }, (_, i) => ({
        id: `other-${i}`,
        name: `Other ${i}`,
      })),
    ].map((m) => ({
      ...m,
      efforts: "efforts" in m ? [...m.efforts] : undefined,
    }));
    await withWebHome(
      { models },
      async ({ provider, configPath, campaignsDir, surface }) => {
        const user = userEvent.setup({ document });
        const view = render(<Root />);
        expect(await view.findByText("Sign in to play.")).toBeTruthy();
        // OMP's real catalog, in player names; no internals on the page
        for (const name of ["Grok", "Claude", "ChatGPT"]) {
          expect(view.getByRole("button", { name })).toBeTruthy();
        }
        expect(view.getByText("Salt dock sandbox.")).toBeTruthy();
        expect(
          view.getByText("No Campaigns yet. Begin one below."),
        ).toBeTruthy();
        expect(view.container.textContent).not.toMatch(
          /fredicus|xai-oauth|auth-broker/i,
        );

        await user.click(view.getByRole("button", { name: "More…" }));
        await user.click(view.getByRole("button", { name: "Lanternlight" }));
        expect(await view.findByText("Paste your key.")).toBeTruthy();
        await user.type(view.getByPlaceholderText("Paste here"), "sk-web");
        await user.click(view.getByRole("button", { name: "Continue" }));

        expect(
          await view.findByText("30 models. Type to find one."),
        ).toBeTruthy();
        expect(provider.signIns).toEqual(["sk-web"]);
        expect(view.getByText("Selected")).toBeTruthy();
        expect(view.queryByRole("button", { name: "Grok" }) === null).toBe(
          true,
        );
        expect(view.queryByText("Other 0") === null).toBe(true);

        const search = view.getByLabelText("Find a model") as HTMLInputElement;
        fireEvent.input(search, { target: { value: "lamp 2 free" } });
        expect(
          view.getByRole("button", { name: "Lamp 2 (free)" }),
        ).toBeTruthy();
        expect(view.queryByRole("button", { name: "Lamp 2" }) === null).toBe(
          true,
        );
        fireEvent.input(search, { target: { value: "lamp" } });
        expect(view.queryByText("Other 0") === null).toBe(true);
        await user.click(view.getByRole("button", { name: "Lamp 2" }));
        expect(view.container.textContent).not.toMatch(/lamp-2-free/);

        expect(await view.findByText("How hard should it think?")).toBeTruthy();
        expect(view.getByRole("button", { name: "Medium" })).toBeTruthy();
        await user.click(view.getByRole("button", { name: "High" }));
        expect(await view.findByText("Lamp 2 · High")).toBeTruthy();
        const saved = await loadConfigFile(configPath);
        expect(saved.model).toBe(`${provider.id}/lamp-2`);
        expect(saved.reasoning).toBe("high");

        // New adventure: pick the Seed Pack, retitle, Begin
        await user.click(view.getByRole("button", { name: /Brinewatch/ }));
        const title = view.getByLabelText("Title") as HTMLInputElement;
        expect(title.value).toBe("Brinewatch");
        await user.clear(title);
        await user.type(title, "Salt Lamp Nights");
        await user.click(view.getByRole("button", { name: "Begin" }));

        // the book opens on the new Campaign's opening, read from disk

        expect(
          await view.findByText(
            /Mira Venn watches you from the Salt Lamp doorway/,
          ),
        ).toBeTruthy();
        const open = (await surface.snapshot()).open!;
        expect(open.name).toBe("Salt Lamp Nights");
        expect(open.path.startsWith(campaignsDir)).toBe(true);
        expect(
          await readFile(path.join(open.path, "campaign.yaml"), "utf8"),
        ).toContain("Salt Lamp Nights");
      },
    );
  });

  test("Continue opens a Campaign; delete warns, stays open when the disk refuses, then deletes", async () => {
    await withWebHome(
      { config: { model: "llama.cpp-remote/story" } },
      async ({ campaignsDir, root }) => {
        const packDir = path.join(root, "packs", "brinewatch");
        const dock = await birthLibraryCampaign({
          packDir,
          title: "Dock Nights",
          campaignsDir,
        });
        await birthLibraryCampaign({
          packDir,
          title: "Tide Ledger",
          campaignsDir,
        });

        const user = userEvent.setup({ document });
        const view = render(<Root />);
        expect(await view.findByText("Dock Nights")).toBeTruthy();
        expect(view.getByText("Tide Ledger")).toBeTruthy();

        await user.click(
          view.getByRole("button", { name: "Delete Dock Nights" }),
        );
        const dialog = view.getByRole("alertdialog", {
          name: 'Delete "Dock Nights"?',
        });
        expect(dialog.textContent).toContain(
          "permanently deletes the entire Campaign folder from disk",
        );
        expect(dialog.textContent).toContain("This cannot be undone.");
        expect(
          (view.container.querySelector(".home-book") as HTMLElement).inert,
        ).toBe(true);

        // a real failure: the library folder is read-only
        await chmod(campaignsDir, 0o555);
        await user.click(
          view.getByRole("button", { name: "Delete from disk" }),
        );
        expect(
          await view.findByText("Could not delete that Campaign from disk."),
        ).toBeTruthy();
        expect(view.getByRole("alertdialog")).toBeTruthy();
        expect(
          await Bun.file(path.join(dock.path, "campaign.yaml")).exists(),
        ).toBe(true);

        await chmod(campaignsDir, 0o755);
        // the failed attempt settles before the button offers itself again
        await user.click(
          await view.findByRole("button", { name: "Delete from disk" }),
        );
        await waitFor(() =>
          expect(view.queryByRole("alertdialog") === null).toBe(true),
        );
        await waitFor(() =>
          expect(view.queryByText("Dock Nights") === null).toBe(true),
        );
        expect(
          await Bun.file(path.join(dock.path, "campaign.yaml")).exists(),
        ).toBe(false);

        // Continue: open the remaining Campaign into the book
        await user.click(view.getByRole("button", { name: /^Tide Ledger/ }));
        expect(
          await view.findByText(
            /Mira Venn watches you from the Salt Lamp doorway/,
          ),
        ).toBeTruthy();
        expect(view.getByPlaceholderText("What do you do?")).toBeTruthy();
      },
    );
  });

  test("Settings saves to the config file", async () => {
    // a local Game Master, so the local knobs are part of Settings
    await withWebHome(
      { config: { model: "llama.cpp/slow-model" } },
      async ({ configPath, surface }) => {
        const user = userEvent.setup({ document });
        const view = render(<Root />);
        await user.click(await view.findByRole("button", { name: "Settings" }));
        expect(
          view.getByText(
            "Also retains this many recent Turns after compaction.",
          ),
        ).toBeTruthy();
        expect(
          view.queryByLabelText(
            /Tail kept after compaction|Absolute tail override/,
          ) === null,
        ).toBe(true);

        const timeout = view.getByLabelText(
          /Turn inactivity timeout/,
        ) as HTMLInputElement;
        expect(timeout.value).toBe("180");
        const budget = view.getByLabelText(
          /Reasoning budget/,
        ) as HTMLInputElement;
        expect(budget.value).toBe("-1");
        const seed = view.getByLabelText(
          /Rebuild seed ceiling/,
        ) as HTMLInputElement;
        expect(seed.value).toBe("50");
        fireEvent.input(timeout, { target: { value: "900" } });
        fireEvent.input(view.getByLabelText(/Context ceiling/), {
          target: { value: "60000" },
        });
        fireEvent.input(seed, { target: { value: "40" } });
        fireEvent.input(view.getByLabelText(/Max reply tokens/), {
          target: { value: "4096" },
        });
        fireEvent.input(budget, { target: { value: "2048" } });
        fireEvent.input(view.getByLabelText(/GM personality/), {
          target: { value: "Patient, severe, and attentive to old grudges." },
        });
        fireEvent.input(view.getByLabelText(/Local thinking opener/), {
          target: {
            value: "First, map the relationships among everyone present.",
          },
        });
        expect(view.getByRole("dialog", { name: "Settings" })).toBeTruthy();
        await user.click(view.getByRole("button", { name: "Save settings" }));

        // a local model shows the loading panel while the save lands, then
        // Home settles with both panels gone
        await waitFor(() =>
          expect(
            view.queryByRole("dialog", { name: "Settings" }) === null &&
              view.queryByRole("dialog", {
                name: "Loading local Game Master",
              }) === null,
          ).toBe(true),
        );
        const file = await Bun.file(configPath).text();
        expect(file).toContain("timeout = 900");
        expect(surface.config.turnTimeoutMs).toBe(900_000);
        const saved = await loadConfigFile(configPath);
        // the ceiling stays inside the local model's context: 80% of 65,536
        expect(saved.compactCeilingTokens).toBe(52_428);
        expect(saved.maxTokens).toBe(4_096);
        expect(file).toContain("max_tokens = 4096");
        expect(saved.localReasoningTokens).toBe(2_048);
        expect(file).toContain(
          "Patient, severe, and attentive to old grudges.",
        );
        expect(file).toContain(
          "First, map the relationships among everyone present.",
        );
      },
    );
  });

  test("This computer: sampling knobs take decimals typed key by key", async () => {
    const temperatures: Array<number | undefined> = [];
    await withWebHome(
      {
        local: [{ alias: "first", size: 12 * GIB }],
        prepareModel: async (_model, opts) => {
          temperatures.push(opts.tuning?.temperature);
        },
      },
      async ({ configPath }) => {
        const user = userEvent.setup({ document });
        const view = render(<Root />);
        await user.click(
          await view.findByRole("button", { name: /^This computer/ }),
        );
        await view.findByRole("dialog", { name: "This computer" });
        const temperature = view.getByLabelText(/^Temperature/) as HTMLInputElement;
        // unset: Auto decides (a qwen3 file reads as Qwen 3, thinking), and
        // its value shows as the placeholder
        expect(temperature.value).toBe("");
        expect(temperature.placeholder).toBe("0.6");

        // "0.0" on the way to "0.05" must not collapse to "0"
        await user.clear(temperature);
        await user.type(temperature, "0.05");
        expect(temperature.value).toBe("0.05");

        await user.click(view.getByRole("button", { name: "Load Game Master" }));
        await waitFor(() => expect(temperatures).toEqual([0.05]));
        await waitFor(async () =>
          expect((await loadConfigFile(configPath)).localTuning?.temperature).toBe(0.05),
        );
      },
    );
  });

  test("This computer: blank knobs show and follow the model's own sampling", async () => {
    const warmups: Array<Record<string, number> | undefined> = [];
    await withWebHome(
      {
        local: [
          {
            alias: "tuned",
            // a family the Almanac does not know, so the file's own values count
            architecture: "storyteller",
            // what a model card's recommended sampling looks like in a GGUF
            metadata: { "general.sampling.temp": 0.6, "general.sampling.top_k": 20 },
          },
        ],
        prepareModel: async (_model, opts) => {
          warmups.push(opts.tuning as Record<string, number> | undefined);
        },
      },
      async ({ configPath }) => {
        const user = userEvent.setup({ document });
        const view = render(<Root />);
        await user.click(
          await view.findByRole("button", { name: /^This computer/ }),
        );
        await view.findByRole("dialog", { name: "This computer" });
        const field = (label: RegExp) => view.getByLabelText(label) as HTMLInputElement;
        expect(field(/^Temperature/).placeholder).toBe("0.6");
        expect(field(/^Top-K/).placeholder).toBe("20");
        // no recommendation in the file: the Almanac's General entry
        expect(field(/^Top-P/).placeholder).toBe("0.95");
        expect(field(/^Min-P/).placeholder).toBe("0.05");
        // nor there: Atomic's own default
        expect(field(/^Repeat window/).placeholder).toBe("64");

        await user.type(field(/^Top-P/), "0.9");
        await user.click(view.getByRole("button", { name: "Load Game Master" }));
        // only the knob the player set travels; the rest follow the model
        await waitFor(() => expect(warmups).toEqual([{ topP: 0.9 }]));
        await waitFor(async () =>
          expect((await loadConfigFile(configPath)).localTuning).toEqual({ topP: 0.9 }),
        );
      },
    );
  });

  test("This computer: Auto asks what a finetune is built on, keeps the answer in the Almanac, and launches the engine with it", async () => {
    await withWebHome(
      {
        // saved by the load page before Auto: every knob, which must not
        // read as the player's own values and pin them over Auto
        configToml: [
          'model = "llama.cpp/gaston-27b-pq2_0"',
          "[local]",
          "temperature = 1",
          "top_k = 20",
          "top_p = 0.95",
          "min_p = 0",
          "repeat_penalty = 1",
          "repeat_last_n = 64",
          "presence_penalty = 0",
          "frequency_penalty = 0",
          "dry_multiplier = 0",
          "dry_base = 1.75",
          "fit_target = 100",
          "",
        ].join("\n"),
        host: {
          alias: "gaston-27b-pq2_0",
          // an architecture several families share, and a name none of them
          architecture: "qwen35",
          metadata: {
            "general.name": "Gaston 27B",
            // copied from the base model's config, as most GGUFs are
            "general.sampling.temp": 1.0,
          },
          engine: { holdReasoning: false, reply: "The tide turns." },
        },
      },
      async ({ configPath, host }) => {
        const user = userEvent.setup({ document });
        const view = render(<Root />);
        await user.click(
          await view.findByRole("button", { name: /^This computer/ }),
        );
        await view.findByRole("dialog", { name: "This computer" });
        const field = (label: RegExp) => view.getByLabelText(label) as HTMLInputElement;

        // only the architecture matched, so Auto guesses and asks
        const card = view.getByRole("region", { name: "Temperament" });
        expect(card.textContent).toContain("Probably");
        expect(card.textContent).not.toContain("of yours");
        expect(field(/^Temperature/).value).toBe("");
        expect(await view.findByText(/Which model is this built on\?/)).toBeTruthy();
        await user.click(view.getByRole("radio", { name: /^Qwen 3\.8/ }));
        expect(field(/^For files named like/).value).toBe("*gaston-27b*");
        await user.click(view.getByRole("button", { name: "Remember this" }));
        await view.findByText("You told Auto this is built on Qwen 3.8.");

        // the answer is one of the player's entries, beside the config
        const { loadAlmanac } = await import("@nq/local-inference/almanac_store.ts");
        const yours = await loadAlmanac(configPath);
        expect(yours).toHaveLength(1);
        expect(yours[0]).toMatchObject({
          title: "Gaston 27B",
          match: { names: ["*gaston-27b*"] },
          extends: "qwen-3.8",
        });

        // Qwen 3.8 wants different sampling with thinking off
        expect(field(/^Temperature/).placeholder).toBe("1.0");
        fireEvent.change(view.getByLabelText(/^Thinking level/), {
          target: { value: "off" },
        });
        expect(field(/^Temperature/).placeholder).toBe("0.7");
        expect(field(/^Presence penalty/).placeholder).toBe("1.5");
        await user.type(field(/^Min-P/), "0.02");

        // the Almanac opens over the load page and lists the new entry
        await user.click(view.getByRole("button", { name: "Open the Almanac ›" }));
        await view.findByRole("dialog", { name: "The Almanac" });
        await view.findByRole("button", { name: /Gaston 27B/ });
        await user.click(view.getByRole("button", { name: "‹ This computer" }));
        await view.findByRole("dialog", { name: "This computer" });
        // the player's own value survived the visit
        expect(field(/^Min-P/).value).toBe("0.02");

        await user.click(view.getByRole("button", { name: "Load Game Master" }));
        await waitFor(() => expect(host!.engine.spawns.length).toBe(1));
        const args = host!.engine.spawns[0]!;
        const flag = (name: string) => args[args.indexOf(name) + 1];
        // the entry outranks the file's own temperature; the player's Min-P wins
        expect(flag("--temp")).toBe("0.7");
        expect(flag("--top-p")).toBe("0.8");
        expect(flag("--top-k")).toBe("20");
        expect(flag("--presence-penalty")).toBe("1.5");
        expect(flag("--min-p")).toBe("0.02");
        // VRAM headroom is no sampling knob: the saved value still counts
        expect(flag("--fit-target")).toBe("100");

        // only the player's own values are saved; Auto recomputes the rest
        await waitFor(async () => {
          const saved = await loadConfigFile(configPath);
          expect(saved.model).toBe("llama.cpp/gaston-27b-pq2_0");
          expect(saved.reasoning).toBe("off");
          expect(saved.localTuning).toEqual({ minP: 0.02, fitTarget: 100 });
        });
      },
    );
  });

  test("the Almanac: copy a book entry into your hand, see which models it catches, and tear it out", async () => {
    await withWebHome(
      {
        local: [
          {
            alias: "lucent-witch-31b.i1-iq3_xxs",
            architecture: "gemma4",
            metadata: { "general.base_model.count": 1, "general.base_model.0.name": "Gemma 4 31B It" },
          },
        ],
      },
      async ({ configPath }) => {
        const { loadAlmanac } = await import("@nq/local-inference/almanac_store.ts");
        const user = userEvent.setup({ document });
        const view = render(<Root />);
        await user.click(await view.findByRole("button", { name: "Almanac" }));
        await view.findByRole("dialog", { name: "The Almanac" });

        // the book's entry for the family, recognised through the base model
        await user.click(await view.findByRole("button", { name: /^Gemma 4/ }));
        await view.findByRole("heading", { name: "Gemma 4" });
        expect(view.getByText("lucent-witch-31b.i1-iq3_xxs")).toBeTruthy();

        await user.click(view.getByRole("button", { name: "Copy into your hand" }));
        const title = view.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
        await user.clear(title);
        await user.type(title, "Witch at 1.3");
        await user.clear(view.getByLabelText(/^Names like/));
        await user.type(view.getByLabelText(/^Names like/), "*lucent-witch*");
        await user.type(view.getByLabelText("Temperature, always"), "1.3");
        await user.click(view.getByRole("button", { name: "Write it down" }));
        await view.findByRole("heading", { name: "Witch at 1.3" });

        const yours = await loadAlmanac(configPath);
        expect(yours).toEqual([
          {
            id: "yours-witch-at-1.3",
            title: "Witch at 1.3",
            source: "yours",
            match: { names: ["*lucent-witch*"], architecture: ["gemma4"] },
            extends: "gemma-4",
            values: { temperature: 1.3 },
          },
        ]);

        // back in the index: yours comes first, and it now catches the model
        await user.click(view.getByRole("button", { name: "‹ All entries" }));
        const row = await view.findByRole("button", { name: /Witch at 1\.3/ });
        expect(row.textContent).toContain("1 of yours");
        expect(
          (view.getByRole("button", { name: /^Gemma 4/ }).textContent ?? "").includes("of yours"),
        ).toBe(false);

        await user.click(row);
        await user.click(view.getByRole("button", { name: "Tear out…" }));
        await user.click(view.getByRole("button", { name: "Tear it out" }));
        await view.findByText(/Nothing written here yet/);
        expect(await loadAlmanac(configPath)).toEqual([]);
      },
    );
  });

  test("This computer: load a local model, cancel a slow warm-up, and reopen on the remembered choice", async () => {
    const warmups: Array<{
      model: string | undefined;
      contextTokens?: number;
      reasoningTokens?: number;
      cacheV?: string;
      temperature?: number;
    }> = [];
    let hold: PromiseWithResolvers<void> | undefined;
    await withWebHome(
      {
        local: [
          { alias: "first", size: 12 * GIB },
          { alias: "second", size: 24 * GIB },
        ],
        // the engine warm-up is external; the first one hangs until cancelled
        prepareModel: async (model, opts) => {
          warmups.push({
            model,
            contextTokens: opts.contextTokens,
            reasoningTokens: opts.reasoningTokens,
            cacheV: opts.cacheV,
            temperature: opts.tuning?.temperature,
          });
          if (!hold) return;
          await new Promise<void>((resolve, reject) => {
            opts.signal.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("cancelled"), { name: "AbortError" }),
                ),
              { once: true },
            );
            hold!.promise.then(resolve);
          });
        },
      },
      async ({ local, configPath }) => {
        const projector = await local.addProjector("mmproj-seer.gguf");
        const user = userEvent.setup({ document });
        const view = render(<Root />);
        await user.click(
          await view.findByRole("button", { name: /^This computer/ }),
        );

        const dialog = await view.findByRole("dialog", {
          name: "This computer",
        });
        expect(dialog.textContent).toContain("12.0 GiB");
        expect(dialog.textContent).toContain("24.0 GiB");
        const model = view.getByLabelText(/^Model/) as HTMLSelectElement;
        expect(model.value).toBe("llama.cpp/first");
        const budget = view.getByLabelText(
          /^Reasoning budget/,
        ) as HTMLInputElement;
        expect(budget.value).toBe("-1");
        // a lone "-" reads as "" in a number input; it must not become 0
        fireEvent.input(budget, { target: { value: "" } });
        expect(budget.value).not.toBe("0");

        fireEvent.change(model, { target: { value: "llama.cpp/second" } });
        fireEvent.input(view.getByLabelText(/^Context window/), {
          target: { value: "32768" },
        });
        fireEvent.input(budget, { target: { value: "2048" } });
        fireEvent.change(view.getByLabelText(/^Thinking level/), {
          target: { value: "high" },
        });
        fireEvent.change(view.getByLabelText(/^Value cache/), {
          target: { value: "turbo2" },
        });
        const vision = view.getByLabelText(
          /^Vision projector/,
        ) as HTMLSelectElement;
        expect(vision.value).toBe("");
        fireEvent.change(vision, { target: { value: projector } });

        // first attempt: the warm-up hangs; Home stays blocked until cancelled
        hold = Promise.withResolvers<void>();
        await user.click(
          view.getByRole("button", { name: "Load Game Master" }),
        );
        const loading = await view.findByRole("dialog", {
          name: "Loading local Game Master",
        });
        expect(loading.getAttribute("aria-busy")).toBe("true");
        expect(view.getByRole("status").textContent).toContain(
          "Warming the Game Master",
        );
        expect(
          (view.container.querySelector(".home-book") as HTMLElement).inert,
        ).toBe(true);
        await waitFor(() => expect(warmups).toHaveLength(1));
        await user.click(view.getByRole("button", { name: "Cancel loading" }));
        await waitFor(() =>
          expect(
            view.queryByRole("dialog", {
              name: "Loading local Game Master",
            }) === null,
          ).toBe(true),
        );
        expect((await loadConfigFile(configPath)).model).toBeUndefined();
        hold = undefined;

        // reopen: the browser remembered every choice from the first attempt
        await user.click(view.getByRole("button", { name: /^This computer/ }));
        await view.findByRole("dialog", { name: "This computer" });
        expect((view.getByLabelText(/^Model/) as HTMLSelectElement).value).toBe(
          "llama.cpp/second",
        );
        expect(
          (view.getByLabelText(/^Context window/) as HTMLInputElement).value,
        ).toBe("32768");
        expect(
          (view.getByLabelText(/^Value cache/) as HTMLSelectElement).value,
        ).toBe("turbo2");
        // the projector was attached to the model's real installation
        expect(
          (view.getByLabelText(/^Vision projector/) as HTMLSelectElement).value,
        ).toBe(projector);
        fireEvent.change(view.getByLabelText(/^Model/), {
          target: { value: "llama.cpp/first" },
        });
        expect(
          (view.getByLabelText(/^Vision projector/) as HTMLSelectElement).value,
        ).toBe("");
        fireEvent.change(view.getByLabelText(/^Model/), {
          target: { value: "llama.cpp/second" },
        });
        await user.click(
          view.getByRole("button", { name: "Load Game Master" }),
        );

        await waitFor(() => expect(warmups).toHaveLength(2));
        expect(warmups[1]).toEqual({
          model: "llama.cpp/second",
          contextTokens: 32_768,
          reasoningTokens: 2_048,
          cacheV: "turbo2",
          // knobs left blank are not sent: the model's own defaults apply
          temperature: undefined,
        });
        await waitFor(async () =>
          expect((await loadConfigFile(configPath)).model).toBe(
            "llama.cpp/second",
          ),
        );
        const saved = await loadConfigFile(configPath);
        expect(saved.reasoning).toBe("high");
        expect(saved.localContextTokens).toBe(32_768);
        expect(saved.localReasoningTokens).toBe(2_048);
        expect(saved.localCacheV).toBe("turbo2");
        const installation = JSON.parse(
          await readFile(path.join(local.rootDir, "installation.json"), "utf8"),
        ) as { models: Array<{ alias: string; mmproj?: { path: string } }> };
        expect(
          installation.models.find((m) => m.alias === "second")?.mmproj?.path,
        ).toBe(projector);
        expect(await view.findByText(/Signed in: This computer/)).toBeTruthy();
      },
    );
  });
  test("This computer: download the Vulkan engine, pick the second GPU, and run the Game Master on it", async () => {
    const nvidia = "NVIDIA GeForce RTX 3080 Ti";
    const arc = "Intel(R) Arc(TM) Pro B70 Graphics";
    await withWebHome(
      {
        host: {
          backend: "cuda-12.4",
          devices: `Available devices:\n  CUDA0: ${nvidia} (12136 MiB, 11421 MiB free)\n`,
        },
      },
      async ({ root, configPath, host }) => {
        // Atomic's GitHub release is remote: a real archive of an engine that
        // sees both cards, which NQ downloads, verifies and extracts for real.
        // The installed build was made locally, so GitHub has no release by
        // its name and NQ takes the Vulkan build from its default release.
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
        const fetched: string[] = [];
        const routed = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.startsWith("https://api.github.com/repos/AtomicBot-ai/")) {
            fetched.push(url);
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
          if (url === "https://downloads.test/vulkan.tar.gz") {
            fetched.push(url);
            return new Response(bytes);
          }
          return routed(input, init);
        }) as typeof fetch;
        try {
          const user = userEvent.setup({ document });
          const view = render(<Root />);
          await user.click(
            await view.findByRole("button", { name: /^This computer/ }),
          );
          await view.findByRole("dialog", { name: "This computer" });
          const gpu = () => view.getByLabelText(/^GPU/) as HTMLSelectElement;
          const options = () => Array.from(gpu().options).map((option) => option.text);
          // the installed CUDA build reaches only the NVIDIA card
          expect(options()).toEqual([
            "Automatic",
            `${nvidia} — CUDA, 11.9 GiB`,
          ]);
          expect(gpu().value).toBe("");

          await user.click(
            view.getByRole("button", { name: "Find more GPUs with Vulkan" }),
          );
          await waitFor(() => expect(options()).toHaveLength(4));
          expect(options()).toEqual([
            "Automatic",
            `${nvidia} — CUDA, 11.9 GiB`,
            `${nvidia} — Vulkan, 12.0 GiB`,
            `${arc} — Vulkan, 31.9 GiB`,
          ]);
          expect(fetched).toEqual([
            "https://api.github.com/repos/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tags/test",
            `https://api.github.com/repos/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tags/${DEFAULT_ATOMIC_RELEASE}`,
            "https://downloads.test/vulkan.tar.gz",
          ]);
          // nothing left to download
          expect(
            view.queryByRole("button", { name: /^Find more GPUs/ }) === null,
          ).toBe(true);

          const arcOption = Array.from(gpu().options).find((option) =>
            option.text.startsWith(arc),
          )!;
          const plainAttention = () =>
            view.getByLabelText(/^Turn off flash attention/) as HTMLInputElement;
          expect(plainAttention().checked).toBe(false);
          fireEvent.change(gpu(), { target: { value: arcOption.value } });
          // flash attention crawls on Intel's Vulkan driver, so picking the
          // Arc turns it off, and the caches it needs quantized go to f16
          expect(plainAttention().checked).toBe(true);
          expect(
            (view.getByLabelText(/^Value cache/) as HTMLSelectElement).value,
          ).toBe("f16");
          await user.click(
            view.getByRole("button", { name: "Load Game Master" }),
          );

          // the Vulkan build launches, pinned to the Arc by the number it gave it
          await waitFor(() => expect(host!.engine.spawns.length).toBe(1));
          expect(host!.engine.commands[0]).toBe(
            path.join(
              host!.rootDir,
              "runtime",
              DEFAULT_ATOMIC_RELEASE,
              "vulkan",
              "build",
              "bin",
              "llama-server",
            ),
          );
          const args = host!.engine.spawns[0]!;
          expect(args[args.indexOf("--device") + 1]).toBe("Vulkan1");
          expect(args[args.indexOf("-fa") + 1]).toBe("off");
          expect(args[args.indexOf("-ctk") + 1]).toBe("f16");
          expect(args[args.indexOf("-ctv") + 1]).toBe("f16");
          await waitFor(async () =>
            expect((await loadConfigFile(configPath)).localGpu).toEqual({
              backend: "vulkan",
              device: "Vulkan1",
              name: arc,
            }),
          );
          expect((await loadConfigFile(configPath)).localFlashAttention).toBe(
            false,
          );
          expect(await view.findByText(/Signed in: This computer/)).toBeTruthy();
        } finally {
          globalThis.fetch = routed;
        }
      },
    );
  });
  test("This computer: an EXL3 model needs the exl3xpu engine, which downloads in the background, then serves several games with a RAM cache", async () => {
    await withWebHome({ host: { exl3: true } }, async ({ root, configPath, host }) => {
      // the engine is not there yet; its image comes from a (fake) registry
      await rm(path.join(host!.rootDir, "engines", "exl3xpu", "engine.json"));
      const registry = await fakeExl3xpuRegistry(root);
      const routed = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.startsWith("https://ghcr.io/")
          ? registry.fetch(url, init)
          : routed(input, init);
      }) as typeof fetch;
      try {
        const user = userEvent.setup({ document });
        const view = render(<Root />);
        await user.click(await view.findByRole("button", { name: /^This computer/ }));
        await view.findByRole("dialog", { name: "This computer" });

        const model = view.getByLabelText(/^Model/) as HTMLSelectElement;
        expect(model.value).toBe(`llama.cpp/${host!.alias}`);
        expect(model.selectedOptions[0]!.text).toContain("EXL3 on exl3xpu");
        // exl3xpu picks the Intel GPU itself
        expect(view.queryByLabelText(/^GPU/) === null).toBe(true);
        const load = () => view.getByRole("button", { name: "Load Game Master" }) as HTMLButtonElement;
        expect(load().disabled).toBe(true);

        await user.click(view.getByRole("button", { name: "Download the exl3xpu engine" }));
        // the download runs in the background; the page follows the snapshot
        await waitFor(() => expect(load().disabled).toBe(false), { timeout: 20_000 });
        expect(
          view.queryByRole("button", { name: "Download the exl3xpu engine" }) === null,
        ).toBe(true);
        expect(registry.requests.some((url) => url.includes("/blobs/"))).toBe(true);

        // shared with other players: four games at once, idle caches kept in RAM
        const parallel = () => view.getByLabelText(/^Games at once/) as HTMLInputElement;
        const ramCache = () => view.getByLabelText(/^RAM cache/) as HTMLInputElement;
        expect(parallel().value).toBe("1");
        expect(ramCache().value).toBe("0");
        fireEvent.input(parallel(), { target: { value: "4" } });
        fireEvent.input(ramCache(), { target: { value: "2" } });

        await user.click(load());
        await waitFor(() => expect(host!.engine.spawns.length).toBe(1));
        const args = host!.engine.spawns[0]!;
        expect(args).toContain("/opt/venv/bin/vllm");
        expect(args[args.indexOf("--max-num-seqs") + 1]).toBe("4");
        // a lazy RAM tier: blocks move to RAM only as they leave the card
        expect(JSON.parse(args[args.indexOf("--kv-transfer-config") + 1]!)).toMatchObject({
          kv_connector: "SimpleCPUOffloadConnector",
          kv_connector_extra_config: { cpu_bytes_to_use: 2 * 2 ** 30, lazy_offload: true },
        });
        await waitFor(async () =>
          expect((await loadConfigFile(configPath)).model).toBe(`llama.cpp/${host!.alias}`),
        );
        await view.findByText(/Signed in: This computer/);
        const saved = JSON.parse(
          await readFile(path.join(path.dirname(configPath), "local_profiles.json"), "utf8"),
        ) as { models: Record<string, { parallel: number; ramCacheGiB: number }> };
        expect(saved.models[host!.alias]).toMatchObject({ parallel: 4, ramCacheGiB: 2 });

        // the model reopens on its own sharing settings
        await user.click(view.getByRole("button", { name: /^This computer/ }));
        await view.findByRole("dialog", { name: "This computer" });
        expect(parallel().value).toBe("4");
        expect(ramCache().value).toBe("2");
      } finally {
        globalThis.fetch = routed;
      }
    });
  });
  test("This computer: each model keeps its own engine profile, and a model too big for the CUDA card defaults to the Arc", async () => {
    const nvidia = "NVIDIA GeForce RTX 3080 Ti";
    const arc = "Intel(R) Graphics (BMG G31)";
    await withWebHome(
      {
        host: {
          backend: "cuda-12.4",
          devices: `Available devices:\n  CUDA0: ${nvidia} (12136 MiB, 11421 MiB free)\n`,
        },
      },
      async ({ configPath, host }) => {
        // the Vulkan build is already downloaded and sees both cards
        await writeDeviceScript(
          path.join(host!.rootDir, "runtime", "test", "vulkan", "build", "bin", "llama-server"),
          "Available devices:\n" +
            `  Vulkan0: ${nvidia} (12288 MiB, 11000 MiB free)\n` +
            `  Vulkan1: ${arc} (32656 MiB, 32000 MiB free)\n`,
        );
        // a second, 16 GiB model: more than the 12 GiB card holds
        const big = path.join(host!.rootDir, "models", "Big-Model-Q4_K_M.gguf");
        await writeGgufFixture(big, { architecture: "qwen3", values: { "qwen3.block_count": 4 } });
        await truncate(big, 16 * GIB);

        const user = userEvent.setup({ document });
        const view = render(<Root />);
        await user.click(await view.findByRole("button", { name: /^This computer/ }));
        await view.findByRole("dialog", { name: "This computer" });
        const model = () => view.getByLabelText(/^Model/) as HTMLSelectElement;
        const gpu = () => view.getByLabelText(/^GPU/) as HTMLSelectElement;
        const gpuText = () => gpu().selectedOptions[0]!.text;
        const plain = () =>
          view.getByLabelText(/^Turn off flash attention/) as HTMLInputElement;
        const context = () => view.getByLabelText(/^Context window/) as HTMLInputElement;

        // unmapped models get a default by fit
        fireEvent.change(model(), { target: { value: "llama.cpp/big-model" } });
        expect(gpuText()).toStartWith(arc);
        expect(plain().checked).toBe(true);
        expect(view.getByText(/New here: NQ suggests where this model runs/)).toBeTruthy();
        fireEvent.change(model(), { target: { value: `llama.cpp/${host!.alias}` } });
        expect(gpu().value).toBe("");
        expect(plain().checked).toBe(false);
        // sharing the engine between games is exl3xpu's alone
        expect(view.queryByLabelText(/^Games at once/) === null).toBe(true);

        // the small model's own choice is kept for it alone
        fireEvent.input(context(), { target: { value: "32768" } });
        await user.click(view.getByRole("button", { name: "Load Game Master" }));
        await waitFor(() => expect(host!.engine.spawns.length).toBe(1));
        expect(host!.engine.commands[0]).toBe(
          path.join(host!.rootDir, "runtime", "build", "bin", "llama-server"),
        );
        await view.findByText(/Signed in: This computer/);

        await user.click(view.getByRole("button", { name: /^This computer/ }));
        await view.findByRole("dialog", { name: "This computer" });
        expect(model().value).toBe(`llama.cpp/${host!.alias}`);
        expect(context().value).toBe("32768");
        expect(view.getByText(/Loads with the engine settings you last used/)).toBeTruthy();
        // unmapped, the big model starts from the latest settings, on the card that fits it
        fireEvent.change(model(), { target: { value: "llama.cpp/big-model" } });
        expect(context().value).toBe("32768");
        expect(gpuText()).toStartWith(arc);
        fireEvent.input(context(), { target: { value: "16384" } });

        // the big model loads where its profile says: the Arc, through Vulkan
        await user.click(view.getByRole("button", { name: "Load Game Master" }));
        await waitFor(() => expect(host!.engine.spawns.length).toBe(2));
        const args = host!.engine.spawns[1]!;
        expect(host!.engine.commands[1]).toBe(
          path.join(host!.rootDir, "runtime", "test", "vulkan", "build", "bin", "llama-server"),
        );
        expect(args[args.indexOf("--device") + 1]).toBe("Vulkan1");
        expect(args[args.indexOf("-fa") + 1]).toBe("off");

        const saved = JSON.parse(
          await readFile(path.join(path.dirname(configPath), "local_profiles.json"), "utf8"),
        ) as { models: Record<string, { contextTokens: number; gpu: unknown }> };
        expect(saved.models[host!.alias]).toMatchObject({ contextTokens: 32_768, gpu: null });
        expect(saved.models["big-model"]!.contextTokens).toBe(16_384);
        expect(saved.models["big-model"]!.gpu).toEqual({
          backend: "vulkan",
          device: "Vulkan1",
          name: arc,
        });
      },
    );
  });
});
