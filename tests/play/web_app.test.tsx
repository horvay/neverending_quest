/**
 * Top-level web Player Surface: the real Root over the real `nq serve` stack
 * (HTTP routes, Play Session, Play Loop, OMP adapter and agent, Campaign
 * tools, Campaign folder and git). Only the model behind the Game Master, the
 * local engine process and the image generator are faked.
 */
import {
  installDom,
  installHandlerFetch,
  paintSittings,
  preferReducedMotion,
  serveBook,
  serveHome,
  waitForLoopIdle,
  type BookServer,
} from "./dom_setup.ts";

installDom();

const { afterEach, describe, expect, test } = await import("bun:test");
const { cleanup, fireEvent, render, waitFor, within } = await import(
  "@testing-library/preact"
);
const userEvent = (await import("@testing-library/user-event")).default;
// user-event's default document is whichever DOM was up when it was first
// imported (maybe an earlier test file's, since closed): name ours
const newUser = () => userEvent.setup({ document });
const path = await import("node:path");
const { Root } = await import("../../src/surfaces/web/client/client.tsx");
const { castTiming } = await import("../../src/surfaces/web/client/dice_overlay.tsx");
const { HomeSurface } = await import("../../src/home/index.ts");
const { mergeConfig } = await import("../../src/config.ts");
const { ILLUSTRATION_BTW_PREFIX } = await import(
  "../../src/play/illustration.ts"
);

// dice casts settle at once so a roll never holds the book behind the overlay
preferReducedMotion();
Object.assign(castTiming, { holdMs: 20, reducedHoldMs: 20, fadeMs: 10 });
const { loadPlayState, readScratch, readTranscript, savePlayState } =
  await import("../../src/campaign/index.ts");
const { birthCampaign } = await import("../helpers/campaign.ts");
const { makeTempDir, rmTempDir } = await import("../helpers/fs.ts");
const { scriptedGameMaster, says } = await import("../helpers/game_master.ts");
const { startLocalHost } = await import("../helpers/local_host.ts");
type ModelCall = import("../helpers/game_master.ts").ModelCall;

afterEach(() => {
  cleanup();
});

const BRINEWATCH_SEED =
  "# Brinewatch\n\n## Opening message\n\nMira Venn watches you from the Salt Lamp doorway.\n";

/** The hidden illustration lookup: rewrite the latest scene as tags. */
const isLookup = (c: ModelCall) =>
  c.instruction.startsWith(ILLUSTRATION_BTW_PREFIX);

/** Type a line into the composer and press Play, as the player does. */
async function play(
  view: ReturnType<typeof render>,
  text: string,
): Promise<void> {
  const user = newUser();
  const box = view.getByPlaceholderText("What do you do?") as HTMLTextAreaElement;
  await user.click(box);
  await user.type(box, text);
  await user.click(view.getByRole("button", { name: "Play" }));
}

describe("web Player Surface — the book over the real stack", () => {
  test("player types an action and sees Mira's reply in the book", async () => {
    const root = await makeTempDir();
    let restoreFetch = () => {};
    let server: BookServer | undefined;
    let view: ReturnType<typeof render> | undefined;
    try {
      const campaign = await birthCampaign(root, {
        name: "Brinewatch",
        seed: BRINEWATCH_SEED,
        sheet:
          "## Description\n**Ren Caldew** — a lean dock runner out of Brinewatch.\n\n## Inventory\n\n## Powers\n### Salt-lung\n\n## Notes\n",
      });
      const gm = await scriptedGameMaster({
        fallback: says("Mira looks at your hands, not your face."),
      });
      server = await serveBook({ path: campaign, factory: gm.factory });
      restoreFetch = installHandlerFetch(server.handler);

      view = render(<Root />);
      expect(await view.findByText(/Mira Venn watches you/)).toBeTruthy();

      await play(view, "I nod to Mira and ask if the attic is still on tab.");
      expect(await view.findByText(/I nod to Mira/)).toBeTruthy();
      expect(await view.findByText(/Mira looks at your hands/)).toBeTruthy();
      // what the book sent is what the Game Master answered, and it is kept
      expect(gm.calls[0]?.prompt).toBe(
        "I nod to Mira and ask if the attic is still on tab.",
      );
      await server.idle();
      expect(
        (await readTranscript(campaign)).map((r) => [r.role, r.text]).slice(-2),
      ).toEqual([
        ["player", "I nod to Mira and ask if the attic is still on tab."],
        ["gm", "Mira looks at your hands, not your face."],
      ]);

      const user = newUser();
      await user.click(view.getByRole("button", { name: "Sheet" }));
      await waitFor(() => {
        expect(view!.getByText(/Ren Caldew/)).toBeTruthy();
        expect(view!.getByText(/Salt-lung/)).toBeTruthy();
      });
    } finally {
      view?.unmount();
      restoreFetch();
      await server?.close();
      await rmTempDir(root);
    }
  });

  test("Stop keeps the streamed reply in the book and frees the composer", async () => {
    const root = await makeTempDir();
    let restoreFetch = () => {};
    let server: BookServer | undefined;
    let view: ReturnType<typeof render> | undefined;
    try {
      const campaign = await birthCampaign(root, {
        name: "Brinewatch",
        seed: BRINEWATCH_SEED,
      });
      // the Game Master writes half a reply, then keeps going until stopped
      const gm = await scriptedGameMaster({
        steps: [
          async (c) => {
            c.say("The door creaks open, and ");
            c.say("a lantern swings");
            await c.aborted();
          },
        ],
        fallback: says("The lantern settles."),
      });
      server = await serveBook({ path: campaign, factory: gm.factory });
      restoreFetch = installHandlerFetch(server.handler);

      view = render(<Root />);
      expect(await view.findByText(/Mira Venn watches you/)).toBeTruthy();
      await play(view, "I push the door.");
      expect(await view.findByText(/a lantern swings/)).toBeTruthy();

      await newUser().click(view.getByRole("button", { name: "Stop" }));

      const composer = (await view.findByPlaceholderText(
        "What do you do?",
      )) as HTMLTextAreaElement;
      await waitFor(() => expect(composer.disabled).toBe(false));
      expect(view.getByRole("button", { name: "Play" })).toBeTruthy();
      const settled = [
        ...view.container.querySelectorAll(".story-block.gm:not(.draft) .prose"),
      ].map((el) => el.textContent);
      expect(settled.at(-1)).toBe("The door creaks open, and a lantern swings");
      // Stop really aborted the model call, and the kept reply is on disk
      expect(gm.calls[0]?.signal?.aborted).toBe(true);
      await server.idle();
      expect((await readTranscript(campaign)).at(-1)).toMatchObject({
        role: "gm",
        text: "The door creaks open, and a lantern swings",
      });
    } finally {
      view?.unmount();
      restoreFetch();
      await server?.close();
      await rmTempDir(root);
    }
  });

  test("a local Game Master: Home waits while it loads, then Answer now cuts its reasoning short", async () => {
    const root = await makeTempDir();
    const loaded = Promise.withResolvers<void>();
    // a real Local Inference Host over a fake llama-server that is still
    // loading its model, then thinks until the host relays `reasoning_end`
    const host = await startLocalHost({
      defaultRoot: true,
      engine: {
        loading: loaded.promise,
        reasoning: "Weighing what Mira already knows about the ferry.",
        reply: 'Mira shrugs. "Two strangers, both paid in iron."',
      },
    });
    let restoreFetch = () => {};
    let close = async () => {};
    let view: ReturnType<typeof render> | undefined;
    try {
      const campaignsDir = path.join(root, "campaigns");
      const campaign = await birthCampaign(campaignsDir, {
        name: "Dock Nights",
        seed: BRINEWATCH_SEED,
      });
      // `nq serve` Home as src/cli.ts builds it for `llama.cpp/<model>`:
      // the Game Master is OMP's llama.cpp client over the host, the model is
      // warmed through the host, and Answer now is the host's cutoff
      const config = mergeConfig({ model: `llama.cpp/${host.alias}` }, {});
      const surface = new HomeSurface({
        config,
        configPath: path.join(root, "config.toml"),
        packsDir: path.join(root, "packs"),
        campaignsDir,
        // as the CLI wires it: the cap is read from Home's config on every call
        factory: await host.gameMaster({ maxTokens: () => config.maxTokens }),
        prepareModel: host.prepareModel,
        endReasoning: host.endReasoning,
      });
      const server = await serveHome(surface);
      close = () => server.close();
      restoreFetch = installHandlerFetch(server.handler);

      view = render(<Root />);
      fireEvent.click(await view.findByRole("button", { name: "Dock Nights" }));

      // Continue blocks Home at once while the engine loads the model
      const dialog = await view.findByRole("dialog", {
        name: "Loading local Game Master",
      });
      expect(dialog.getAttribute("aria-busy")).toBe("true");
      expect(
        (view.container.querySelector(".home-book") as HTMLElement).inert,
      ).toBe(true);
      // the host has started the engine, which is still loading the model
      await waitFor(() => expect(host.engine.running()).toBe(true));

      loaded.resolve();
      expect(await view.findByText(/Mira Venn watches you/)).toBeTruthy();
      // a boolean, not the element: a failing expect on a DOM node pretty-prints
      // the whole happy-dom graph on every retry
      await waitFor(() =>
        expect(
          view!.queryByRole("dialog", { name: "Loading local Game Master" }) ===
            null,
        ).toBe(true),
      );

      // a smaller reply cap saved mid-adventure reaches the very next call
      await surface.updatePlaySettings({ maxTokens: 2048 });
      await play(view, "Who came in on the ferry?");
      expect(
        await view.findByText(/Weighing what Mira already knows/),
      ).toBeTruthy();
      expect(host.engine.controls).toEqual([]);

      await newUser()
        .click(await view.findByRole("button", { name: "Answer now" }));

      expect(
        await view.findByText(/Two strangers, both paid in iron/),
      ).toBeTruthy();
      expect(host.engine.controls).toEqual([
        {
          path: "/v1/chat/completions/control",
          body: { id: "chatcmpl-fake-1", action: "reasoning_end" },
        },
      ]);
      expect(host.engine.completions[0]).toMatchObject({
        model: host.alias,
        stream: true,
        reasoning_control: true,
      });
      const limit = host.engine.completions[0]!;
      expect(limit.max_completion_tokens ?? limit.max_tokens).toBe(2048);
      await waitForLoopIdle(surface.play!.loop);
      expect((await readTranscript(campaign)).at(-1)).toMatchObject({
        role: "gm",
        text: 'Mira shrugs. "Two strangers, both paid in iron."',
      });
      expect(view.queryByRole("button", { name: "Answer now" }) === null).toBe(
        true,
      );
    } finally {
      loaded.resolve();
      view?.unmount();
      restoreFetch();
      await close();
      await host.stop();
      await rmTempDir(root);
    }
  });

  test("an EXL3 Game Master on exl3xpu: the host rewrites NQ's prefill for vLLM and emulates Answer now", async () => {
    const root = await makeTempDir();
    // a real Local Inference Host whose model is an EXL3 folder on the exl3xpu
    // engine; vLLM (behind bubblewrap) is the one thing faked
    const host = await startLocalHost({
      defaultRoot: true,
      exl3: true,
      engine: {
        reasoning: "Weighing what Mira already knows about the ferry.",
        reply: 'Mira shrugs. "Two strangers, both paid in iron."',
      },
    });
    let restoreFetch = () => {};
    let close = async () => {};
    let view: ReturnType<typeof render> | undefined;
    try {
      const campaignsDir = path.join(root, "campaigns");
      const campaign = await birthCampaign(campaignsDir, {
        name: "Dock Nights",
        seed: BRINEWATCH_SEED,
      });
      const surface = new HomeSurface({
        // OMP's 32768-token output ceiling does not fit beside the prompt in a 32768 window
        config: mergeConfig(
          {
            model: `llama.cpp/${host.alias}`,
            localReasoningTokens: 2000,
            localContextTokens: 32_768,
          },
          {},
        ),
        configPath: path.join(root, "config.toml"),
        packsDir: path.join(root, "packs"),
        campaignsDir,
        factory: await host.gameMaster({}, { maxTokens: 32_768 }),
        prepareModel: host.prepareModel,
        endReasoning: host.endReasoning,
      });
      const server = await serveHome(surface);
      close = () => server.close();
      restoreFetch = installHandlerFetch(server.handler);

      view = render(<Root />);
      fireEvent.click(await view.findByRole("button", { name: "Dock Nights" }));
      expect(await view.findByText(/Mira Venn watches you/)).toBeTruthy();

      // vLLM in the unpacked engine, sandboxed, drafting with the assistant beside the model
      expect(path.basename(host.engine.commands[0]!)).toBe("bwrap");
      const launch = host.engine.spawns[0]!;
      const flag = (name: string) => launch[launch.indexOf(name) + 1];
      expect(launch).toContain("/opt/venv/bin/vllm");
      expect(flag("--served-model-name")).toBe(host.alias);
      expect(flag("--reasoning-parser")).toBe("gemma4");
      expect(flag("--tool-call-parser")).toBe("gemma4");
      expect(JSON.parse(flag("--speculative-config")!)).toEqual({
        method: "gemma4_mtp",
        model: "/nq/drafter",
        num_speculative_tokens: 2,
      });
      expect(launch).toContain(path.join(host.rootDir, "models", `${host.alias}-assistant`));

      await play(view, "Who came in on the ferry?");
      expect(await view.findByText(/Weighing what Mira already knows/)).toBeTruthy();

      // NQ's Atomic-shaped prefill reached vLLM as the template's hook
      const first = host.engine.completions[0]!;
      const kwargs = first.chat_template_kwargs as Record<string, unknown>;
      expect(kwargs.enable_thinking).toBe(true);
      expect(String(kwargs.nq_prefill)).toStartWith("<|channel>thought\n");
      expect(first.thinking_token_budget).toBe(2000);
      expect(first.continue_final_message).toBeUndefined();
      expect(first.reasoning_control).toBeUndefined();
      expect((first.messages as Array<{ role: string }>).at(-1)!.role).toBe("user");
      // the output ceiling is cut to the room the prompt leaves in the window
      const budget = (body: Record<string, unknown>) =>
        Number(body.max_tokens ?? body.max_completion_tokens);
      expect(budget(first)).toBeLessThan(32_768);
      expect(budget(first)).toBeGreaterThan(0);

      await newUser().click(await view.findByRole("button", { name: "Answer now" }));
      expect(await view.findByText(/Two strangers, both paid in iron/)).toBeTruthy();

      // the host closed the thought so far and resent; vLLM has no /control
      expect(host.engine.controls).toEqual([]);
      const resumed = host.engine.completions[1]!;
      const closedPrefill = String(
        (resumed.chat_template_kwargs as Record<string, unknown>).nq_prefill,
      );
      expect(closedPrefill).toStartWith(String(kwargs.nq_prefill));
      expect(closedPrefill).toContain("Weighing what Mira already knows about the ferry.");
      expect(closedPrefill).toEndWith("\n<channel|>");
      expect(resumed.thinking_token_budget).toBeUndefined();
      // the closed thought is longer prompt, so less room again
      expect(budget(resumed)).toBeLessThan(budget(first));

      await waitForLoopIdle(surface.play!.loop);
      expect((await readTranscript(campaign)).at(-1)).toMatchObject({
        role: "gm",
        text: 'Mira shrugs. "Two strangers, both paid in iron."',
      });
    } finally {
      view?.unmount();
      restoreFetch();
      await close();
      await host.stop();
      await rmTempDir(root);
    }
  });

  test("a local Game Master thinks on from the player's edit of its Scratch", async () => {
    const root = await makeTempDir();
    // a real Local Inference Host over a fake llama-server; the engine is the
    // one thing faked, so the prefill is checked where the model would read it
    const host = await startLocalHost({
      defaultRoot: true,
      engine: {
        holdReasoning: false,
        reasoning: " She owes the ferryman.",
        reply: 'Mira shrugs. "Two strangers, both paid in iron."',
      },
    });
    let restoreFetch = () => {};
    let close = async () => {};
    let view: ReturnType<typeof render> | undefined;
    try {
      const campaignsDir = path.join(root, "campaigns");
      const campaign = await birthCampaign(campaignsDir, {
        name: "Dock Nights",
        seed: BRINEWATCH_SEED,
      });
      // `nq serve` Home as src/cli.ts builds it for `llama.cpp/<model>`
      const surface = new HomeSurface({
        config: mergeConfig({ model: `llama.cpp/${host.alias}` }, {}),
        configPath: path.join(root, "config.toml"),
        packsDir: path.join(root, "packs"),
        campaignsDir,
        factory: await host.gameMaster(),
        prepareModel: host.prepareModel,
      });
      const server = await serveHome(surface);
      close = () => server.close();
      restoreFetch = installHandlerFetch(server.handler);

      // from Home: an address left by an earlier test would open it as well
      window.history.replaceState(null, "", "/");
      view = render(<Root />);
      fireEvent.click(await view.findByRole("button", { name: "Dock Nights" }));
      expect(await view.findByText(/Mira Venn watches you/)).toBeTruthy();

      await play(view, "Who came in on the ferry?");
      expect(await view.findByText(/Two strangers, both paid in iron/)).toBeTruthy();
      await waitForLoopIdle(surface.play!.loop);
      const firstReply = (await readTranscript(campaign)).at(-1)!;

      const user = newUser();
      const lastWho = () =>
        view!.container.querySelector(".story-block.gm.latest .who-hit") as HTMLElement;
      fireEvent.mouseEnter(lastWho());
      await user.click(await view.findByRole("button", { name: "Expand scratch" }));
      await user.click(await view.findByRole("button", { name: "Edit scratch" }));
      const box = view.getByLabelText("edit scratch") as HTMLTextAreaElement;
      // the Scratch as saved: the default opener, then what the engine thought
      expect(box.value).toBe(
        "Let me think through the scene step by step:\n1. She owes the ferryman.",
      );
      await user.clear(box);
      await user.type(box, "Mira lies to protect her brother, so");
      const editor = view.container.querySelector(".scratch-above.is-editing") as HTMLElement;
      const before = host.engine.completions.length;
      await user.click(within(editor).getByRole("button", { name: "Continue" }));

      // the Turn is replayed: the engine got the player's same words, and the
      // edited Scratch as the thinking it continues from
      await waitFor(() => expect(host.engine.completions.length).toBeGreaterThan(before));
      await waitForLoopIdle(surface.play!.loop);
      const sent = host.engine.completions[before]!;
      const messages = sent.messages as Array<Record<string, unknown>>;
      expect(sent.continue_final_message).toBe("reasoning_content");
      expect(messages.at(-2)).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "Who came in on the ferry?" }],
      });
      expect(messages.at(-1)).toMatchObject({
        role: "assistant",
        reasoning_content: "Mira lies to protect her brother, so",
      });

      // the replay replaced the Turn rather than adding one, and its Scratch
      // is the edit followed by what the model thought on from there
      const rows = await readTranscript(campaign);
      expect(rows.slice(-2).map((row) => row.role)).toEqual(["player", "gm"]);
      expect(rows.at(-1)!.ts).not.toBe(firstReply.ts);
      expect(rows.filter((row) => row.role === "player")).toHaveLength(1);
      expect((await loadPlayState(campaign)).success_turn_count).toBe(1);
      expect((await readScratch(campaign)).map((record) => record.thinking)).toEqual([
        "Mira lies to protect her brother, so She owes the ferryman.",
      ]);
      expect(view.queryByLabelText("edit scratch") === null).toBe(true);
    } finally {
      view?.unmount();
      restoreFetch();
      await close();
      await host.stop();
      await rmTempDir(root);
    }
  });

  test("reloading an adventure's address after a restart shows the local model loading", async () => {
    const root = await makeTempDir();
    const loaded = Promise.withResolvers<void>();
    const host = await startLocalHost({
      defaultRoot: true,
      engine: { loading: loaded.promise, reply: "Mira nods." },
    });
    let restoreFetch = () => {};
    let close = async () => {};
    let view: ReturnType<typeof render> | undefined;
    try {
      const campaignsDir = path.join(root, "campaigns");
      await birthCampaign(campaignsDir, {
        name: "Dock Nights",
        seed: BRINEWATCH_SEED,
      });
      // a freshly started `nq serve`: nothing open, the model not loaded yet
      const surface = new HomeSurface({
        config: mergeConfig({ model: `llama.cpp/${host.alias}` }, {}),
        configPath: path.join(root, "config.toml"),
        packsDir: path.join(root, "packs"),
        campaignsDir,
        factory: await host.gameMaster(),
        prepareModel: host.prepareModel,
        endReasoning: host.endReasoning,
      });
      const server = await serveHome(surface);
      close = () => server.close();
      restoreFetch = installHandlerFetch(server.handler);

      // the browser reloads on the adventure's own address
      const home = (await (await fetch("/api/home")).json()) as {
        campaigns: { id: string }[];
      };
      const key = home.campaigns[0]!.id.replace(/-/g, "").slice(0, 8);
      window.history.replaceState(null, "", `/play/dock-nights-${key}`);
      view = render(<Root />);

      // the loading dialog shows, not the bare title
      const dialog = await view.findByRole("dialog", {
        name: "Loading local Game Master",
      });
      expect(dialog.getAttribute("aria-busy")).toBe("true");
      await waitFor(() => expect(host.engine.running()).toBe(true));
      expect(
        view.queryByRole("dialog", { name: "Loading local Game Master" }) !==
          null,
      ).toBe(true);

      loaded.resolve();
      expect(await view.findByText(/Mira Venn watches you/)).toBeTruthy();
      expect(window.location.pathname).toBe(`/play/dock-nights-${key}`);
    } finally {
      loaded.resolve();
      view?.unmount();
      window.history.replaceState(null, "", "/");
      restoreFetch();
      await close();
      await host.stop();
      await rmTempDir(root);
    }
  });

  test("book picks up a later snapshot after the event stream drops", async () => {
    const root = await makeTempDir();
    let restoreFetch = () => {};
    let server: BookServer | undefined;
    let view: ReturnType<typeof render> | undefined;
    try {
      const campaign = await birthCampaign(root, {
        name: "Brinewatch",
        seed: BRINEWATCH_SEED,
      });
      const gm = await scriptedGameMaster({
        fallback: says("Kell lifts a hand from the tiller."),
      });
      server = await serveBook({ path: campaign, factory: gm.factory });
      const book = server;
      // the network drops the first event stream right after its snapshot;
      // the book's reconnect is held until the Turn below has happened
      let streams = 0;
      const reconnect = Promise.withResolvers<void>();
      restoreFetch = installHandlerFetch(async (req) => {
        if (new URL(req.url).pathname !== "/api/events") {
          return book.handler(req);
        }
        streams += 1;
        if (streams === 1) {
          const live = await book.handler(req);
          const reader = live.body!.getReader();
          const decoder = new TextDecoder();
          let head = "";
          while (!head.includes("\n")) {
            const { value, done } = await reader.read();
            if (done) break;
            head += decoder.decode(value, { stream: true });
          }
          await reader.cancel();
          return new Response(`${head.slice(0, head.indexOf("\n") + 1)}`, {
            headers: { "content-type": "application/x-ndjson" },
          });
        }
        await reconnect.promise;
        return book.handler(req);
      });

      view = render(<Root />);
      expect(await view.findByText(/Mira Venn watches you/)).toBeTruthy();
      await waitFor(() => expect(streams).toBe(2));

      // meanwhile the Campaign moves on (the terminal plays a Turn)
      await book.loop.turn("I thank her and look toward the ferry.");
      expect(view.queryByText(/Kell lifts a hand/) === null).toBe(true);

      reconnect.resolve();
      expect(await view.findByText(/Kell lifts a hand/)).toBeTruthy();
      expect(view.getByText(/I thank her and look toward the ferry/)).toBeTruthy();
    } finally {
      view?.unmount();
      restoreFetch();
      await server?.close();
      await rmTempDir(root);
    }
  });

  test("inspect leaf reloads when a turn ends", async () => {
    const root = await makeTempDir();
    let restoreFetch = () => {};
    let server: BookServer | undefined;
    let view: ReturnType<typeof render> | undefined;
    try {
      const campaign = await birthCampaign(root, {
        name: "Brinewatch",
        seed: BRINEWATCH_SEED,
      });
      // after the reply, Memory Hygiene records a new quest on disk
      const gm = await scriptedGameMaster({
        steps: [
          says("Mira looks at your hands, not your face."),
          (c) =>
            c.tool("write", {
              path: "quest-log.md",
              content: "- Settle the attic tab with Mira\n",
            }),
          says("Recorded the attic tab."),
        ],
      });
      server = await serveBook({
        path: campaign,
        factory: gm.factory,
        config: { hygieneN: 1 },
      });
      const book = server;
      let inspectHits = 0;
      restoreFetch = installHandlerFetch(async (req) => {
        if (new URL(req.url).pathname.startsWith("/api/inspect/")) {
          inspectHits += 1;
        }
        return book.handler(req);
      });

      view = render(<Root />);
      expect(await view.findByText(/Mira Venn watches you/)).toBeTruthy();
      await waitFor(() => {
        expect(inspectHits).toBeGreaterThan(0);
      });
      const afterOpen = inspectHits;
      expect(view.queryByText(/Settle the attic tab/) === null).toBe(true);

      await play(view, "I nod to Mira.");
      expect(await view.findByText(/Mira looks at your hands/)).toBeTruthy();
      await waitFor(() => {
        expect(inspectHits).toBeGreaterThan(afterOpen);
      });
      // the open Quests leaf shows what hygiene wrote after the Turn
      expect(await view.findByText(/Settle the attic tab with Mira/)).toBeTruthy();
      expect(gm.calls[1]?.instruction).toStartWith("[Memory Hygiene");
      await book.idle();
    } finally {
      view?.unmount();
      restoreFetch();
      await server?.close();
      await rmTempDir(root);
    }
  });

  test("Continue still extends when play_state success_turn_count drifted", async () => {
    const root = await makeTempDir();
    let restoreFetch = () => {};
    let server: BookServer | undefined;
    let view: ReturnType<typeof render> | undefined;
    try {
      const campaign = await birthCampaign(root, {
        name: "Brinewatch",
        seed: "# Brinewatch\n\n## Opening message\n\nAnd then she\n",
      });
      await savePlayState(campaign, {
        success_turn_count: 306,
        luck_points: 5,
        luck_armed: false,
      });
      const gm = await scriptedGameMaster({ fallback: says("named the price.") });
      server = await serveBook({ path: campaign, factory: gm.factory });
      restoreFetch = installHandlerFetch(server.handler);

      view = render(<Root />);
      expect(await view.findByText(/And then she/)).toBeTruthy();

      const user = newUser();
      const lastWho = () =>
        view!.container.querySelector(
          ".story-block.gm .who-hit",
        ) as HTMLElement;
      await waitFor(() => {
        expect(lastWho()).toBeTruthy();
      });
      fireEvent.mouseEnter(lastWho());
      await user.click(view.getByRole("button", { name: "Continue" }));
      await user.click(
        view.getByRole("button", { name: "Continue from here" }),
      );
      expect(await view.findByText(/named the price/)).toBeTruthy();
      expect(
        view.queryByText(/That line is not on the current play/) === null,
      ).toBe(true);
      // Continue was a hidden instruction, and the line grew on disk
      expect(gm.calls[0]?.instruction).toStartWith("[Continue");
      await server.idle();
      expect((await readTranscript(campaign)).at(-1)?.text).toMatch(
        /^And then she\s*named the price\.$/,
      );
    } finally {
      view?.unmount();
      restoreFetch();
      await server?.close();
      await rmTempDir(root);
    }
  });

  test("hover chip edits, expands scratch, and confirms Continue", async () => {
    const root = await makeTempDir();
    let restoreFetch = () => {};
    let server: BookServer | undefined;
    let view: ReturnType<typeof render> | undefined;
    try {
      const campaign = await birthCampaign(root, {
        name: "Brinewatch",
        seed: BRINEWATCH_SEED,
        dossiers: {
          "mira-venn": "# Mira Venn\n\nWants a chore done, not coin.\n",
        },
      });
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.think("Price is a chore, not coin.");
            c.tool("read", { path: "dossiers/mira-venn.md" });
            c.tool("roll", {
              n: 20,
              i: "Holding the gate: low 1-6, mid 7-14, high 15-20",
            });
          },
          says("And then she"),
        ],
        fallback: says("named the price."),
      });
      server = await serveBook({ path: campaign, factory: gm.factory });
      restoreFetch = installHandlerFetch(server.handler);

      view = render(<Root />);
      expect(await view.findByText(/Mira Venn watches you/)).toBeTruthy();

      const user = newUser();
      await play(view, "I nod to Mira.");
      expect(await view.findByText(/And then she/)).toBeTruthy();
      expect(view.queryByText(/Idle · 1 turn/) === null).toBe(true);
      // the tools really ran: the model read the Dossier and saw the die
      expect(
        gm.calls[1]?.toolResults.find((r) => r.name === "read")?.text,
      ).toContain("Wants a chore done");
      const rolled = gm.calls[1]?.toolResults.find((r) => r.name === "roll");
      expect(rolled?.text).toMatch(/^([1-9]|1\d|20)$/);
      await server.idle();

      const lastWho = () =>
        view!.container.querySelector(
          ".story-block.gm.latest .who-hit",
        ) as HTMLElement;
      await waitFor(() => {
        expect(lastWho()).toBeTruthy();
      });
      fireEvent.mouseEnter(lastWho());
      await waitFor(() => {
        expect(
          view!.getByRole("button", { name: "Expand scratch" }),
        ).toBeTruthy();
      });
      await user.click(view.getByRole("button", { name: "Expand scratch" }));
      const above = view.container.querySelector(".scratch-above");
      expect(above?.textContent).toContain("Price is a chore");
      expect(above?.textContent).toContain("dossiers/mira-venn.md");

      fireEvent.mouseEnter(lastWho());
      await user.click(view.getByRole("button", { name: "Edit" }));
      const editBox = view.getByLabelText("edit row") as HTMLTextAreaElement;
      await user.clear(editBox);
      await user.type(editBox, "And then she waited.");
      await user.click(view.getByRole("button", { name: "Keep this line" }));
      expect(await view.findByText(/And then she waited/)).toBeTruthy();
      expect((await readTranscript(campaign)).at(-1)?.text).toBe(
        "And then she waited.",
      );
      await user.click(view.getByRole("button", { name: "Status" }));
      const rollLog = (
        await view.findByRole("heading", { name: "Rolls" })
      ).closest("section")!;
      await waitFor(() =>
        expect(rollLog.querySelector(".roll-result")?.textContent).toBe(
          `${rolled?.text} / d20`,
        ),
      );
      expect(rollLog.querySelector(".roll-reason")?.textContent).toBe(
        "Holding the gate",
      );

      fireEvent.mouseEnter(lastWho());
      await waitFor(() => {
        expect(view!.getByRole("button", { name: "Continue" })).toBeTruthy();
      });
      await user.click(view.getByRole("button", { name: "Continue" }));
      expect(view.getByText(/Everything after it is cut/)).toBeTruthy();
      await user.click(
        view.getByRole("button", { name: "Continue from here" }),
      );
      expect(await view.findByText(/named the price/)).toBeTruthy();
      await server.idle();
    } finally {
      view?.unmount();
      restoreFetch();
      await server?.close();
      await rmTempDir(root);
    }
  });

  test("an Illustration that cannot be prompted shows on the status line until a later Turn", async () => {
    const root = await makeTempDir();
    let restoreFetch = () => {};
    let server: BookServer | undefined;
    let view: ReturnType<typeof render> | undefined;
    const turning = Promise.withResolvers<void>();
    try {
      const campaign = await birthCampaign(root, {
        name: "Brinewatch",
        seed: BRINEWATCH_SEED,
      });
      const painted: Array<{ prompt: string; slot: number }> = [];
      // the lookup answers chatter instead of tags; the Turn after it waits
      const gm = await scriptedGameMaster({
        fallback: async (c) => {
          if (isLookup(c)) return c.say("Sure, here is a lovely scene.");
          await turning.promise;
          c.say("You wait, and the lamp gutters.");
        },
      });
      server = await serveBook({
        path: campaign,
        factory: gm.factory,
        illustrator: { paintOne: paintSittings({ painted }) },
      });
      restoreFetch = installHandlerFetch(server.handler);

      view = render(<Root />);
      // the small brush in the page head, which narrow screens show
      const brushes = await view.findAllByRole("button", {
        name: "Illustrate this line",
      });
      expect(brushes).toHaveLength(2);
      fireEvent.click(brushes[1]!);
      await waitFor(() => {
        expect(
          view!.container.querySelector(".status-line.err")?.textContent,
        ).toBe("Could not make an image prompt from this scene");
      });
      expect(gm.calls.filter(isLookup)).toHaveLength(1);
      expect(painted).toEqual([]);
      await server.idle();

      // a later Turn clears the stale notice
      await play(view, "I wait.");
      await waitFor(() => {
        expect(
          view!.container.querySelector(".status-line.err") === null,
        ).toBe(true);
        expect(
          view!.container.querySelector(".status-line")?.textContent,
        ).toMatch(/Turning/);
      });
      turning.resolve();
      expect(await view.findByText(/the lamp gutters/)).toBeTruthy();
      await server.idle();
    } finally {
      turning.resolve();
      view?.unmount();
      restoreFetch();
      await server?.close();
      await rmTempDir(root);
    }
  });
});
