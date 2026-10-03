/**
 * The web book, deep: the real Root and BookApp under happy-dom, over the real
 * `nq serve` routes, Play Session and Play Loop, the OMP-backed Game Master
 * with its real Campaign tools, and the Campaign folder and git on disk.
 * Only the model (scripted), the image generator and the engine's log file
 * (written the way the external engine writes it) stand in for outside
 * systems.
 */
import {
  installDom,
  installHandlerFetch,
  paintSittings,
  preferReducedMotion,
  serveBook,
  type BookServer,
} from "./dom_setup.ts";

installDom();

const { afterEach, describe, expect, test } = await import("bun:test");
const { cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/preact"
);
const userEvent = (await import("@testing-library/user-event")).default;
// user-event's default document is whichever DOM was up when it was first
// imported (maybe an earlier test file's, since closed): name ours
const newUser = () => userEvent.setup({ document });
const path = await import("node:path");
const { mkdir, rm, writeFile } = await import("node:fs/promises");
const { Root } = await import("../../src/surfaces/web/client/client.tsx");
const { castTiming } = await import("../../src/surfaces/web/client/dice_overlay.tsx");
const { ILLUSTRATION_BTW_PREFIX, illustrationAbs } = await import(
  "../../src/play/illustration.ts"
);
const { defaultLocalRuntimeDir } = await import("@nq/local-inference/runtime.ts");
const { listCampaignHistory, loadPlayState, readTranscript } = await import(
  "../../src/campaign/index.ts"
);
const { birthCampaign } = await import("../helpers/campaign.ts");
const { makeTempDir, rmTempDir } = await import("../helpers/fs.ts");
const { scriptedGameMaster, says } = await import("../helpers/game_master.ts");
type ModelCall = import("../helpers/game_master.ts").ModelCall;
type ScriptedGameMaster = import("../helpers/game_master.ts").ScriptedGameMaster;
type PlaySessionOptions = import("../../src/play/session.ts").PlaySessionOptions;

preferReducedMotion();
Object.assign(castTiming, { holdMs: 20, reducedHoldMs: 20, fadeMs: 10 });

afterEach(() => {
  cleanup();
});

const OPENING = "Mira Venn watches you from the Salt Lamp doorway.";
const SEED = `# Brinewatch\n\n## Opening message\n\n${OPENING}\n`;

const isLookup = (c: ModelCall) =>
  c.instruction.startsWith(ILLUSTRATION_BTW_PREFIX);
const isHygiene = (c: ModelCall) =>
  c.instruction.startsWith("[Memory Hygiene");

type Book = {
  campaign: string;
  server: BookServer;
  view: ReturnType<typeof render>;
};

/**
 * Birth a Campaign, serve it, and open the book on it. `body` runs with the
 * book on screen; everything is torn down after, pass or fail.
 */
async function withBook(
  opts: {
    gm: ScriptedGameMaster;
    campaign?: Parameters<typeof birthCampaign>[1];
    session?: Omit<PlaySessionOptions, "path" | "factory">;
  },
  body: (book: Book) => Promise<void>,
): Promise<void> {
  const root = await makeTempDir();
  let restoreFetch = () => {};
  let server: BookServer | undefined;
  let view: ReturnType<typeof render> | undefined;
  try {
    const campaign = await birthCampaign(root, {
      name: "Brinewatch",
      seed: SEED,
      ...opts.campaign,
    });
    server = await serveBook({
      path: campaign,
      factory: opts.gm.factory,
      ...opts.session,
    });
    restoreFetch = installHandlerFetch(server.handler);
    view = render(<Root />);
    expect(await view.findByText(/Mira Venn watches you/)).toBeTruthy();
    await body({ campaign, server, view });
  } finally {
    view?.unmount();
    restoreFetch();
    await server?.close();
    await rmTempDir(root);
  }
}

function composer(view: ReturnType<typeof render>): HTMLTextAreaElement {
  return view.getByPlaceholderText("What do you do?") as HTMLTextAreaElement;
}

async function play(view: ReturnType<typeof render>, text: string) {
  const user = newUser();
  await user.click(composer(view));
  await user.type(composer(view), text);
  await user.click(view.getByRole("button", { name: "Play" }));
}

/**
 * happy-dom does no layout, so give the story pane the geometry a browser
 * would: a scroll height the test grows as text arrives, a fixed viewport,
 * and a scrollTop clamped like a real one.
 */
function paneGeometry(pane: HTMLElement) {
  const g = { scrollHeight: 1_000, scrollTop: 0, clientHeight: 200 };
  Object.defineProperties(pane, {
    scrollHeight: { configurable: true, get: () => g.scrollHeight },
    clientHeight: { configurable: true, get: () => g.clientHeight },
    scrollTop: {
      configurable: true,
      get: () => g.scrollTop,
      set: (value: number) => {
        g.scrollTop = Math.min(value, g.scrollHeight - g.clientHeight);
      },
    },
  });
  return g;
}

/**
 * Let the frame the book just rendered finish. Preact runs effects after
 * paint (on the next animation frame), and a leaf that just loaded resets its
 * Seek and ink state in such an effect; a player cannot type into it sooner.
 */
async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => setTimeout(resolve, 0)),
  );
}

/**
 * Click a control once the book unlocks it. The book locks its controls while
 * a request is in flight (saving, filing), as a player would see.
 */
async function clickWhenReady(
  view: ReturnType<typeof render>,
  name: string,
): Promise<void> {
  const button = (await view.findByRole("button", { name })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await newUser().click(button);
}

/** Hover the n-th story row's who-label, as the reader's pointer does. */
function hoverRow(view: ReturnType<typeof render>, index: number) {
  const hits = view.container.querySelectorAll(".who-hit");
  for (const block of view.container.querySelectorAll(".story-block")) {
    fireEvent.mouseLeave(block);
  }
  fireEvent.mouseEnter(hits[index] as HTMLElement);
}

describe("web book — deep flows", () => {
  test("Enter plays and Shift+Enter does not; the story follows a streaming reply until the reader scrolls up", async () => {
    const chunks = [0, 1, 2].map(() => Promise.withResolvers<void>());
    const thoughts = [0, 1, 2].map(() => Promise.withResolvers<void>());
    const gm = await scriptedGameMaster({
      steps: [
        async (c) => {
          c.say("The tide begins to turn.");
          await chunks[0]!.promise;
          c.say(" A bell sounds.");
          await chunks[1]!.promise;
          c.say(" It sounds offshore.");
          await chunks[2]!.promise;
          c.say(" Twice.");
        },
        async (c) => {
          c.think("Checking the tide.");
          await thoughts[0]!.promise;
          c.think(" And Mira's route.");
          await thoughts[1]!.promise;
          c.think(" And the customs post.");
          await thoughts[2]!.promise;
          c.say("Mira takes the long way round.");
        },
      ],
    });
    try {
      await withBook({ gm }, async ({ campaign, server, view }) => {
        const pane = view.container.querySelector(".play") as HTMLElement;
        const g = paneGeometry(pane);
        const box = composer(view);

        // Shift+Enter is a line break, not a Turn
        fireEvent.input(box, { target: { value: "I wade into the shallows." } });
        fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
        expect(box.value).toBe("I wade into the shallows.");
        expect(server.loop.loopState).toBe("idle");
        expect(gm.calls).toHaveLength(0);

        // Enter plays it, and the reader follows the reply as it streams
        fireEvent.keyDown(box, { key: "Enter" });
        expect(await view.findByText(/The tide begins to turn\./)).toBeTruthy();
        expect(gm.calls[0]?.prompt).toBe("I wade into the shallows.");
        await waitFor(() => expect(g.scrollTop).toBe(800));

        // scrolled up to reread: new text must not pull the page down
        pane.scrollTop = 400;
        fireEvent.scroll(pane);
        g.scrollHeight = 1_200;
        chunks[0]!.resolve();
        expect(await view.findByText(/A bell sounds\./)).toBeTruthy();
        expect(g.scrollTop).toBe(400);

        // back at the bottom: following resumes
        pane.scrollTop = 1_000;
        fireEvent.scroll(pane);
        g.scrollHeight = 1_400;
        chunks[1]!.resolve();
        expect(await view.findByText(/It sounds offshore\./)).toBeTruthy();
        await waitFor(() => expect(g.scrollTop).toBe(1_200));
        chunks[2]!.resolve();
        expect(await view.findByText(/Twice\./)).toBeTruthy();
        await server.idle();

        // scrolled up again, a new Turn brings the reader back to the end
        g.scrollHeight = 1_600;
        pane.scrollTop = 300;
        fireEvent.scroll(pane);
        fireEvent.input(box, { target: { value: "I follow Mira into the fog." } });
        fireEvent.keyDown(box, { key: "Enter" });
        expect(await view.findByText("Checking the tide.")).toBeTruthy();
        await waitFor(() => expect(g.scrollTop).toBe(1_400));

        // a scroll event that lands late (at the old bottom) while the live
        // Scratch grows does not count as the reader scrolling away
        g.scrollHeight = 1_700;
        thoughts[0]!.resolve();
        expect(await view.findByText(/And Mira's route\./)).toBeTruthy();
        await waitFor(() => expect(g.scrollTop).toBe(1_500));
        g.scrollHeight = 1_800;
        fireEvent.scroll(pane);
        thoughts[1]!.resolve();
        expect(await view.findByText(/And the customs post\./)).toBeTruthy();
        await waitFor(() => expect(g.scrollTop).toBe(1_600));
        thoughts[2]!.resolve();
        expect(await view.findByText(/Mira takes the long way round/)).toBeTruthy();
        await server.idle();

        expect(
          (await readTranscript(campaign)).map((r) => r.text).slice(1),
        ).toEqual([
          "I wade into the shallows.",
          "The tide begins to turn. A bell sounds. It sounds offshore. Twice.",
          "I follow Mira into the fog.",
          "Mira takes the long way round.",
        ]);
      });
    } finally {
      for (const d of [...chunks, ...thoughts]) d.resolve();
    }
  });

  test("the other leaf: veiled Twists, Dossier Seek and Archives, and inking over a stale leaf", async () => {
    const twist = "The ferryman already sold the map to the Ash Court.";
    // the Turn's Memory Hygiene plans a twist on disk
    const gm = await scriptedGameMaster({
      steps: [
        says("Kell shrugs and looks at the water."),
        (c) => c.tool("write", { path: "twists.md", content: `- ${twist}\n` }),
        says("Planned a twist."),
      ],
    });
    await withBook(
      {
        gm,
        session: { config: { hygieneN: 1 } },
        campaign: {
          dossiers: {
            "mira-venn":
              "---\nname: Mira Venn\nkind: person\n---\n\n# Mira Venn\n\nInnkeeper. Keeps a salt lamp.\n",
            "kell-brine":
              "---\nname: Kell Brine\nkind: person\n---\n\n# Kell Brine\n\nDock runner. Mentions Mira often.\n",
          },
        },
      },
      async ({ campaign, server, view }) => {
        const user = newUser();
        await play(view, "I ask Kell about the ferry.");
        expect(await view.findByText(/Kell shrugs/)).toBeTruthy();
        await server.idle();
        expect(isHygiene(gm.calls[1]!)).toBe(true);

        // Twists: blurred behind a veil, not withheld, until read on purpose
        await user.click(view.getByRole("button", { name: "Twists" }));
        await waitFor(() =>
          expect(
            view.container.querySelector(".spoiler-veil")?.textContent,
          ).toContain(twist),
        );
        expect(view.getByText(/Read ahead anyway/)).toBeTruthy();
        fireEvent.click(view.container.querySelector(".spoiler-veil")!);
        await waitFor(() =>
          expect(view.container.querySelector(".spoiler-veil") === null).toBe(
            true,
          ),
        );
        expect(view.container.querySelector(".ms-ink")?.textContent).toContain(
          twist,
        );

        // Dossiers: names once, Seek by name or by a phrase from the body
        await user.click(view.getByRole("button", { name: "Dossiers" }));
        expect(await view.findByRole("button", { name: "Mira Venn" })).toBeTruthy();
        expect(view.getByRole("button", { name: "Kell Brine" })).toBeTruthy();
        await nextFrame();
        const seek = view.getByLabelText("Seek") as HTMLInputElement;
        fireEvent.input(seek, { target: { value: "mira" } });
        const named = () =>
          view
            .getAllByRole("button")
            .map((el: HTMLElement) => el.textContent)
            .filter((t: string | null) => t === "Mira Venn" || t === "Kell Brine");
        // a title hit ranks above a body hit, which shows its line
        expect(named()).toEqual(["Mira Venn", "Kell Brine"]);
        expect(view.getByText(/Mentions Mira often/)).toBeTruthy();
        fireEvent.input(seek, { target: { value: "salt lamp" } });
        expect(named()).toEqual(["Mira Venn"]);
        fireEvent.input(seek, { target: { value: "kind: person" } });
        expect(view.getByText("Nothing on these leaves matches.")).toBeTruthy();
        fireEvent.input(seek, { target: { value: "" } });

        // Archive files Mira into a collapsed Archives section, on disk too
        const miraRow = view
          .getByRole("button", { name: "Mira Venn" })
          .closest("li")!;
        fireEvent.click(miraRow.querySelector(".file-leaf")!);
        await waitFor(() =>
          expect(view.container.querySelector("details.filed-leaves")).toBeTruthy(),
        );
        const filed = view.container.querySelector(
          "details.filed-leaves",
        ) as HTMLDetailsElement;
        expect(filed.open).toBe(false);
        expect(filed.textContent).toContain("Mira Venn");
        expect(
          await Bun.file(
            path.join(campaign, "dossiers", "archive", "mira-venn.md"),
          ).exists(),
        ).toBe(true);
        // a Seek that only hits a filed leaf opens the section
        fireEvent.input(view.getByLabelText("Seek"), {
          target: { value: "salt lamp" },
        });
        await waitFor(() =>
          expect(
            (
              view.container.querySelector(
                "details.filed-leaves",
              ) as HTMLDetailsElement
            ).open,
          ).toBe(true),
        );
        expect(view.queryByRole("button", { name: "Kell Brine" }) === null).toBe(true);
        // the leaf stays locked until the filing has finished
        await clickWhenReady(view, "Restore this leaf");
        await waitFor(() =>
          expect(
            view.container.querySelector("details.filed-leaves") === null,
          ).toBe(true),
        );
        expect(
          await Bun.file(path.join(campaign, "dossiers", "mira-venn.md")).exists(),
        ).toBe(true);

        // Sheet: ink the leaf while someone else changes the file on disk
        await user.click(view.getByRole("button", { name: "Sheet" }));
        await view.findByRole("button", { name: "Ink this leaf" });
        await nextFrame();
        await clickWhenReady(view, "Ink this leaf");
        await waitFor(() =>
          expect(view.container.querySelector("#inspect-body") !== null).toBe(true),
        );
        const ink = (text: string) =>
          fireEvent.input(view.container.querySelector("#inspect-body")!, {
            target: { value: text },
          });
        ink("## Description\nA ranger with a salt-cured bow.\n");
        const sheet = path.join(campaign, "player_sheet.md");
        await writeFile(sheet, "## Description\nchanged on disk\n");
        await clickWhenReady(view, "Set this leaf");
        // the save is refused: the leaf shows what is on disk now
        expect(await view.findByText(/showing disk text/i)).toBeTruthy();
        await waitFor(() =>
          expect(
            view.container.querySelector(".manuscript-leaf")?.textContent,
          ).toContain("changed on disk"),
        );
        expect(await Bun.file(sheet).text()).toBe("## Description\nchanged on disk\n");
        // inking again over the disk text now lands
        await nextFrame();
        await clickWhenReady(view, "Ink this leaf");
        await waitFor(() =>
          expect(view.container.querySelector("#inspect-body") !== null).toBe(true),
        );
        expect(
          (view.container.querySelector("#inspect-body") as HTMLTextAreaElement)
            .value,
        ).toBe("## Description\nchanged on disk\n");
        ink("## Description\nA ranger with a salt-cured bow.\n");
        await clickWhenReady(view, "Set this leaf");
        await waitFor(async () =>
          expect(await Bun.file(sheet).text()).toBe(
            "## Description\nA ranger with a salt-cured bow.\n",
          ),
        );
        expect(await view.findByText(/salt-cured bow/)).toBeTruthy();
        await server.idle();
      },
    );
  });

  test("Retry and Strike live only on the last row; a failed hygiene pass shows on the status line", async () => {
    // Memory Hygiene runs after each Turn here, and its provider call fails
    const gm = await scriptedGameMaster({
      fallback: (c) => {
        if (isHygiene(c)) {
          throw new Error("400 Bad Request: could not compress Tide Choir copy");
        }
        c.say(
          gm.calls.filter((call) => !isHygiene(call)).length === 1
            ? "Mira looks at your hands."
            : "Mira looks past you, at the door.",
        );
      },
    });
    await withBook(
      { gm, session: { config: { hygieneN: 1 } } },
      async ({ campaign, server, view }) => {
        await play(view, "I wait.");
        expect(await view.findByText(/Mira looks at your hands/)).toBeTruthy();
        await server.idle();

        // the hidden pass failed: its error is a status line, not GM prose
        await waitFor(() =>
          expect(
            view.container.querySelector(".status-line.err")?.textContent,
          ).toBe("400 Bad Request: could not compress Tide Choir copy"),
        );
        expect(view.queryByText(/could not compress/, { selector: ".prose" }) === null).toBe(true);
        expect((await readTranscript(campaign)).map((r) => r.role)).toEqual([
          "gm",
          "player",
          "gm",
        ]);

        // the opening row offers neither Retry nor Strike
        hoverRow(view, 0);
        expect(view.queryByRole("button", { name: "Retry" }) === null).toBe(true);
        expect(view.queryByRole("button", { name: "Strike" }) === null).toBe(true);

        // Retry on the last reply asks the Game Master again
        hoverRow(view, 2);
        await clickWhenReady(view, "Retry");
        expect(await view.findByText(/Mira looks past you/)).toBeTruthy();
        await server.idle();
        const plays = gm.calls.filter((c) => !isHygiene(c));
        expect(plays.map((c) => c.prompt)).toEqual(["I wait.", "I wait."]);
        expect((await readTranscript(campaign)).map((r) => r.text)).toEqual([
          OPENING,
          "I wait.",
          "Mira looks past you, at the door.",
        ]);

        // Strike removes the last exchange from the book and the Campaign
        hoverRow(view, 2);
        await clickWhenReady(view, "Strike");
        await waitFor(() =>
          expect(view.queryByText(/Mira looks past you/) === null).toBe(true),
        );
        expect(view.queryByText("I wait.") === null).toBe(true);
        await server.idle();
        expect((await readTranscript(campaign)).map((r) => r.text)).toEqual([
          OPENING,
        ]);
      },
    );
  });

  test("a Turn that fails without a reply offers Try again right on the message", async () => {
    // the Game Master stays silent through the first Turn's own attempts
    let answers = false;
    const gm = await scriptedGameMaster({
      fallback: (c) => c.say(answers ? "Mira sets down her cup." : "   "),
    });
    await withBook({ gm }, async ({ campaign, server, view }) => {
      await play(view, "I wave.");
      await server.idle();

      // the failure sits under the message, not on the status line too
      await waitFor(() =>
        expect(
          view.container.querySelector(".story-block.player .unanswered")
            ?.textContent,
        ).toContain("The Game Master finished without replying"),
      );
      expect(view.container.querySelector(".status-line.err") === null).toBe(
        true,
      );
      expect((await readTranscript(campaign)).map((r) => r.role)).toEqual([
        "gm",
        "player",
      ]);

      answers = true;
      const silent = gm.calls.length;
      await clickWhenReady(view, "Try again");
      expect(await view.findByText(/Mira sets down her cup/)).toBeTruthy();
      await server.idle();
      expect(view.queryByRole("button", { name: "Try again" }) === null).toBe(
        true,
      );
      expect(gm.calls.at(silent)?.prompt).toBe("I wave.");
      expect((await readTranscript(campaign)).map((r) => r.text)).toEqual([
        OPENING,
        "I wave.",
        "Mira sets down her cup.",
      ]);
    });
  });

  test("a Luck Point arms the next roll, which lands in the Status roll list", async () => {
    const gm = await scriptedGameMaster({
      steps: [
        (c) =>
          c.tool("roll", {
            n: 20,
            i: "Holding the gate: low 1-6, mid 7-14, high 15-20",
          }),
        says("The gate holds."),
      ],
    });
    await withBook({ gm }, async ({ campaign, server, view }) => {
      const user = newUser();
      await user.click(view.getByRole("button", { name: "Status" }));
      const luck = await view.findByRole("switch", {
        name: "Use a Luck Point on the next roll",
      });
      expect(luck.getAttribute("aria-checked")).toBe("false");
      expect(view.getByText("5 left")).toBeTruthy();

      fireEvent.click(luck);
      await waitFor(async () =>
        expect((await loadPlayState(campaign)).luck_armed).toBe(true),
      );
      await waitFor(() =>
        expect(
          view
            .getByRole("switch", { name: "Use a Luck Point on the next roll" })
            .getAttribute("aria-checked"),
        ).toBe("true"),
      );

      await play(view, "I brace the gate.");
      expect(await view.findByText(/The gate holds/)).toBeTruthy();
      await server.idle();
      // the Luck Point made the real roll its best face
      expect(gm.calls[1]?.toolResults).toMatchObject([{ name: "roll", text: "20" }]);
      expect(await loadPlayState(campaign)).toMatchObject({
        luck_points: 4,
        luck_armed: false,
      });

      const log = (await view.findByRole("heading", { name: "Rolls" })).closest(
        "section",
      ) as HTMLElement;
      await waitFor(() =>
        expect(
          Array.from(log.querySelectorAll("li")).map((row) => ({
            turn: row.querySelector(".roll-turn")?.textContent,
            result: row.querySelector(".roll-result")?.textContent,
            reason: row.querySelector(".roll-reason")?.textContent,
          })),
        ).toEqual([
          { turn: "Turn I", result: "20 / d20", reason: "Holding the gate" },
        ]),
      );
      await waitFor(() => expect(view.getByText("4 left")).toBeTruthy());
      expect(
        view
          .getByRole("switch", { name: "Use a Luck Point on the next roll" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });
  });

  test("the easel: mixing, four sittings, keep one, look again, regenerate; a missing picture is hidden", async () => {
    const lookup = Promise.withResolvers<void>();
    const laterSlots = Promise.withResolvers<void>();
    const painted: Array<{ prompt: string; slot: number }> = [];
    const gm = await scriptedGameMaster({
      fallback: async (c) => {
        if (!isLookup(c)) return c.say("The lake is still.");
        await lookup.promise;
        c.say("pov, pov hands, full_body, 1girl, elf, lake");
      },
    });
    try {
      await withBook(
        {
          gm,
          session: {
            // the image generator is external: slot 0 paints at once, the
            // rest wait until the test lets them
            illustrator: { paintOne: paintSittings({
              painted,
              gate: (slot) => (slot === 0 ? Promise.resolve() : laterSlots.promise),
            }) },
          },
        },
        async ({ campaign, server, view }) => {
          const user = newUser();
          const [opening] = await readTranscript(campaign);
          // the desk brush (the page head carries a small one for narrow screens)
          const [deskBrush] = await view.findAllByRole("button", {
            name: "Illustrate this line",
          });
          fireEvent.click(deskBrush!);
          const mixing = await view.findByRole("dialog", {
            name: "The brush is mixing a sitting.",
          });
          expect(mixing.querySelector(".easel-body")?.getAttribute("src")).toBe(
            "/ink/studio-easel.png",
          );
          expect(mixing.textContent).toContain("The brush is mixing pigments.");

          // the lookup answers; the first sitting can be picked while the
          // rest are still painting, and the prompt is not yet editable
          lookup.resolve();
          const grid = await view.findByRole("dialog", { name: "Pick a sitting." });
          expect(grid.querySelectorAll(".easel-cell").length).toBe(4);
          expect(grid.querySelectorAll(".easel-cell.is-wait").length).toBe(3);
          expect(view.getAllByRole("button", { name: "Use this sitting" })).toHaveLength(1);
          expect(
            view.queryByDisplayValue("pov, pov hands, full body, 1girl, elf, lake") ===
              null,
          ).toBe(true);
          expect(gm.calls.filter(isLookup)).toHaveLength(1);
          expect(gm.calls.filter(isLookup)[0]?.instruction).toContain(OPENING);

          laterSlots.resolve();
          await waitFor(() =>
            expect(view.getAllByRole("button", { name: "Use this sitting" })).toHaveLength(4),
          );
          await user.click(view.getAllByRole("button", { name: "Use this sitting" })[1]!);
          const kept = await view.findByRole("dialog", {
            name: "The sitting. pov, pov hands, full body, 1girl, elf, lake",
          });
          const src = kept.querySelector(".easel-picture")?.getAttribute("src") ?? "";
          expect(src).toContain(`/api/illustrations/${encodeURIComponent(opening!.ts)}`);
          expect(view.queryAllByRole("button", { name: "Use this sitting" })).toHaveLength(0);
          await server.idle();
          // kept on disk, stamped on the row, committed, and served
          expect((await readTranscript(campaign))[0]).toMatchObject({
            illustration: expect.any(String),
          });
          expect((await listCampaignHistory(campaign)).length).toBeGreaterThan(1);
          const png = await server.handler(new Request(new URL(src, "http://127.0.0.1:7737")));
          expect(png.status).toBe(200);
          expect(painted.map((p) => p.slot).sort()).toEqual([0, 1, 2, 3]);

          // Leave it: the easel goes, the picture stays in the story
          await user.click(view.getByRole("button", { name: "Leave it" }));
          expect(view.queryByRole("dialog", { name: /The sitting/ }) === null).toBe(true);
          expect(view.container.querySelector("img.illustration")).toBeTruthy();

          // look again, rewrite the sitting, and paint it anew
          await user.click(view.getByRole("button", { name: "Look at this sitting" }));
          const box = view.getByRole("textbox", { name: "The sitting" });
          fireEvent.input(box, {
            target: { value: "cowboy_shot, 1girl, elf, lake, laughing" },
          });
          await user.click(view.getByRole("button", { name: "Regenerate" }));
          await waitFor(() =>
            expect(view.getAllByRole("button", { name: "Use this sitting" })).toHaveLength(4),
          );
          // the written prompt was painted as given; no new lookup call
          expect(painted.slice(4).map((p) => p.prompt)).toEqual(
            Array(4).fill("cowboy shot, 1girl, elf, lake, laughing"),
          );
          expect(gm.calls.filter(isLookup)).toHaveLength(1);
          await user.click(view.getAllByRole("button", { name: "Use this sitting" })[0]!);
          expect(
            await view.findByRole("dialog", {
              name: "The sitting. cowboy shot, 1girl, elf, lake, laughing",
            }),
          ).toBeTruthy();
          fireEvent.keyDown(window, { key: "Escape" });
          await waitFor(() =>
            expect(view.queryByRole("dialog", { name: /The sitting/ }) === null).toBe(true),
          );
          await server.idle();

          // the picture goes missing from disk: the frame hides, not breaks
          await rm(illustrationAbs(campaign, opening!.ts));
          await nextFrame();
          const pic = view.container.querySelector("img.illustration") as HTMLImageElement;
          const gone = await server.handler(
            new Request(new URL(pic.getAttribute("src")!, "http://127.0.0.1:7737")),
          );
          expect(gone.status).toBe(404);
          fireEvent.error(pic); // what the browser does with that 404
          await waitFor(() =>
            expect(view.container.querySelector("img.illustration") === null).toBe(true),
          );
        },
      );
    } finally {
      lookup.resolve();
      laterSlots.resolve();
    }
  });

  test("the AI log drawer reads the local engine's log over its route", async () => {
    const logs = path.join(defaultLocalRuntimeDir(), "logs");
    const gm = await scriptedGameMaster();
    try {
      // what a running llama-server leaves in NQ's local root
      await mkdir(logs, { recursive: true });
      await writeFile(
        path.join(logs, "llama-server.log"),
        "slot update: prompt processing\n",
      );
      await withBook({ gm }, async ({ view }) => {
        expect(view.queryByLabelText("Local AI diagnostics") === null).toBe(true);
        fireEvent.click(view.getByRole("button", { name: "AI log" }));
        const drawer = view.getByLabelText("Local AI diagnostics");
        await waitFor(() =>
          expect(drawer.querySelector(".local-log-output")?.textContent).toContain(
            "slot update: prompt processing",
          ),
        );
        fireEvent.change(drawer.querySelector("select")!, {
          target: { value: "host" },
        });
        await waitFor(() =>
          expect(drawer.querySelector(".local-log-output")?.textContent).toBe(
            "No inference host log yet. It appears when the local host starts.",
          ),
        );
        fireEvent.click(view.getByRole("button", { name: "AI log" }));
        expect(view.queryByLabelText("Local AI diagnostics") === null).toBe(true);
      });
    } finally {
      await rm(logs, { recursive: true, force: true });
    }
  });
});
