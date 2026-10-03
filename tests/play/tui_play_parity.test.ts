import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultLocalRuntimeDir } from "@nq/local-inference/runtime.ts";
import { readScratch } from "../../src/campaign/scratch.ts";
import {
  ILLUSTRATION_BTW_PREFIX,
  illustrationAbs,
} from "../../src/play/illustration.ts";
import { says, type ModelCall } from "../helpers/game_master.ts";
import { startLocalHost } from "../helpers/local_host.ts";
import {
  OPENING,
  gated,
  gitLog,
  idle,
  onCleanup,
  openPlay,
  settled,
  storyOf,
  transcript,
  until,
} from "../helpers/tui.ts";
import { paintSittings } from "./dom_setup.ts";

/**
 * The terminal Player Surface does what the web book does at the table:
 * Retry, Answer now, Luck Points and the Roll Log, Inspect (read, ink,
 * Dossiers), Illustrations, play settings, the AI log and help. Each journey
 * drives `nq play` (OpenTUI test renderer) over the real HomeSurface, Play
 * Loop, OMP adapter and a Campaign folder with git; only the model, the
 * engine process, the painter and the image viewer are fake.
 */

const isLookup = (c: ModelCall) => c.instruction.startsWith(ILLUSTRATION_BTW_PREFIX);

describe("nq play (OpenTUI) at parity with the web book", () => {
  test("/retry tries a failed line again and replays the latest Turn; /luck maxes the roll the Roll Log lists; /stop", async () => {
    const play = await openPlay({
      steps: [
        () => {
          throw new Error("provider is down");
        },
        says("Mira points at the fish stall."),
        (c) => c.tool("roll", { n: 20, reason: "Spot the pickpocket" }),
        says("You catch him by the collar."),
        (c) => c.tool("roll", { n: 6 }),
        says("He slips into the crowd."),
        async (c) => {
          c.say("The tide turns and");
          await c.aborted();
        },
      ],
    });
    await play.frame((f) => f.includes("Idle · 0 turns · Luck 5"));

    // a Turn that fails leaves its line unanswered, with the way back under it
    await play.enter("I search the crowd.");
    const failed = await play.frame((f) => f.includes("Try again with /retry"));
    expect(storyOf(failed)).toContain("The Game Master finished without replying");
    await idle(play);
    await play.enter("/retry");
    await play.frame((f) => f.includes("Mira points at the fish stall.") && f.includes("Idle · 1 turn"));
    await settled(play, "turn 1");
    expect(play.gm.calls[1]?.prompt).toBe("I search the crowd.");
    expect((await transcript(play.campaign)).map((r) => [r.role, r.text])).toEqual([
      ["gm", OPENING],
      ["player", "I search the crowd."],
      ["gm", "Mira points at the fish stall."],
    ]);

    // arm a Luck Point: the next real roll lands on its highest face
    await play.enter("/luck");
    await play.frame((f) => f.includes("The next die will land on its highest face."));
    play.setup.mockInput.pressEscape();
    await play.frame((f) => f.includes("Idle · 1 turn · Luck 5 armed"));
    await play.enter("I chase the pickpocket.");
    const rolled = await play.frame(
      (f) => f.includes("You catch him by the collar.") && f.includes("Luck 4"),
    );
    expect(rolled).toContain("Rolled d20 → 20 · Spot the pickpocket");
    expect(rolled).not.toContain("Luck 4 armed");
    await settled(play, "turn 2");

    await play.enter("/rolls");
    const rolls = await play.frame((f) => f.includes("Status · Rolls"));
    expect(rolls).toContain("Turn 2 · 20 / d20 · Spot the pickpocket");
    expect(rolls).toContain("Esc back");
    play.setup.mockInput.pressEscape();
    await play.frame((f) => f.includes("You catch him by the collar.") && f.includes("Idle"));

    // Retry replays the latest Turn: same words, a new reply, one Turn
    await play.enter("/retry");
    const replayed = await play.frame(
      (f) => f.includes("He slips into the crowd.") && f.includes("Idle · 2 turns"),
    );
    expect(storyOf(replayed)).not.toContain("You catch him by the collar.");
    expect(replayed).toContain("Rolled d6 → ");
    expect(replayed).toContain("Purpose not recorded.");
    await until(async () => (await transcript(play.campaign)).at(-1)?.text === "He slips into the crowd.");
    await idle(play);
    expect(play.gm.calls[4]?.prompt).toBe("I chase the pickpocket.");
    const rows = await transcript(play.campaign);
    expect(rows.filter((r) => r.role === "player").map((r) => r.text)).toEqual([
      "I search the crowd.",
      "I chase the pickpocket.",
    ]);
    await play.enter("/rolls");
    const relisted = await play.frame((f) => f.includes("Status · Rolls"));
    expect(relisted).toMatch(/Turn 2 · \d \/ d6 · Purpose not recorded\./u);
    expect(relisted).not.toContain("d20");
    play.setup.mockInput.pressEscape();
    await play.frame((f) => !f.includes("Status · Rolls"));

    // /stop is Stop typed out: the reply so far is kept
    await play.enter("I wait for the tide.");
    await play.frame((f) => f.includes("The tide turns and") && f.includes("Turning…"));
    await play.enter("/stop");
    await play.frame((f) => f.includes("Idle · 3 turns"));
    await settled(play, "turn 3");
    expect((await transcript(play.campaign)).at(-1)).toMatchObject({
      role: "gm",
      text: "The tide turns and",
    });
  });

  test("Inspect: read a leaf, ink it (stale-aware), enter, archive and restore a Dossier; an open leaf follows Memory Hygiene", async () => {
    const hold = gated();
    const play = await openPlay({
      steps: [
        says("Mira nods."),
        async (c) => {
          await hold.wait;
          c.tool("write", { path: "story-beats.md", content: "- Ren met Mira at the Salt Lamp.\n" });
        },
      ],
      fallback: says("Noted."),
    });
    const sheetFile = path.join(play.campaign, "player_sheet.md");

    await play.enter("/sheet");
    const sheet = await play.frame((f) => f.includes("Who you are · Player Sheet"));
    expect(sheet).toContain("A weary ranger.");
    expect(sheet).toContain("Esc back · /ink to write");

    // ink the leaf: Ctrl+S sets it on disk and commits
    await play.enter("/ink");
    await play.frame((f) => f.includes("Ctrl+S set this leaf"));
    await play.setup.mockInput.typeText("Scarred. ");
    play.setup.mockInput.pressKey("s", { ctrl: true });
    await play.frame((f) => !f.includes("Ctrl+S set this leaf") && f.includes("Scarred."));
    expect(await readFile(sheetFile, "utf8")).toContain("Scarred.");
    await until(async () => (await gitLog(play.campaign)).includes("inspect"));
    await idle(play);

    // the file changes on disk under the open ink: the save shows the disk text
    await play.enter("/ink");
    await play.frame((f) => f.includes("Ctrl+S set this leaf"));
    await writeFile(sheetFile, "## Description\nA hand-edited ranger.\n");
    await play.setup.mockInput.typeText("Mine. ");
    play.setup.mockInput.pressKey("s", { ctrl: true });
    const stale = await play.frame((f) => f.includes("Changed on disk — showing disk text."));
    expect(stale).toContain("A hand-edited ranger.");
    expect(stale).not.toContain("Mine.");
    expect(await readFile(sheetFile, "utf8")).toBe("## Description\nA hand-edited ranger.\n");

    // enter a Dossier, archive it, seek it in the Archives, restore it
    await play.enter("/new Mira Venn");
    const dossier = await play.frame((f) => f.includes("Dossier · "));
    expect(dossier).toContain("/archive");
    expect(await stat(path.join(play.campaign, "dossiers/mira-venn.md"))).toBeTruthy();
    await until(async () => (await gitLog(play.campaign)).includes("dossier"));
    await idle(play);
    await play.enter("/archive");
    await play.frame((f) => f.includes("Archived mira-venn.") && f.includes("Dossier · archived"));
    expect(await stat(path.join(play.campaign, "dossiers/archive/mira-venn.md"))).toBeTruthy();
    await until(async () => (await gitLog(play.campaign)).includes("archive"));
    await idle(play);
    await play.enter("/dossiers");
    const index = await play.frame((f) => f.includes("Dramatis personae · Dossiers"));
    expect(index).toContain("Archives (1) · /archives to list them");
    expect(index).not.toContain("(mira-venn)");
    await play.enter("/dossiers mira");
    const sought = await play.frame((f) => f.includes("Seek: mira"));
    expect(sought).toMatch(/Archives\s+Mira Venn\s+\(mira-venn\)/u);
    await play.enter("/restore mira-venn");
    await play.frame((f) => f.includes("Restored mira-venn."));
    await until(async () => (await gitLog(play.campaign)).includes("unarchive"));
    await idle(play);
    await play.enter("/dossiers");
    const live = await play.frame((f) => f.includes("Dramatis personae · Dossiers") && !f.includes("Seek:"));
    expect(live).toContain("(mira-venn)");
    expect(live).not.toContain("Archives");
    play.setup.mockInput.pressEscape();
    await play.frame((f) => !f.includes("Dramatis personae"));

    // a leaf open while Memory Hygiene writes it shows the new ink when it ends
    await play.enter("I nod to Mira.");
    await play.frame((f) => f.includes("Idle · 1 turn"));
    await settled(play, "turn 1");
    await play.enter("/light");
    await play.frame((f) => f.includes("Memory hygiene…"));
    await play.enter("/beats");
    const clean = await play.frame((f) => f.includes("The chronicle so far · Story Beats"));
    expect(clean).toContain("This leaf is still clean.");
    // writing is Idle only, reading is not
    await play.enter("/ink");
    await play.frame((f) => f.includes("Busy — try again when Idle."));
    hold.open();
    await play.frame((f) => f.includes("Ren met Mira at the Salt Lamp."));
    await until(async () => (await gitLog(play.campaign))[0] === "light");
  });

  test("the brush: /illustrate paints four sittings, /look opens one, /keep stamps the row; /cancel leaves no picture", async () => {
    const later = gated();
    const painted: Array<{ prompt: string; slot: number }> = [];
    const play = await openPlay({
      fallback: (c) =>
        isLookup(c) ? c.say("pov, 1girl, elf, salt dock, lantern") : c.say("Mira nods."),
      home: {
        // the image generator is external: slot 0 paints at once, the rest
        // wait until the test lets them
        illustrator: {
          paintOne: paintSittings({
            painted,
            gate: (slot) => (slot === 0 ? Promise.resolve() : later.wait),
          }),
        },
      },
    });
    const [opening] = await transcript(play.campaign);

    await play.enter("/illustrate");
    const painting = await play.frame(
      (f) => f.includes("1  ready · /look 1") && f.includes("Painting… · 1 of 4 sittings"),
    );
    expect(painting).toContain("pov, 1girl, elf, salt dock, lantern");
    expect(painting).toContain("2  painting…");
    expect(play.gm.calls.filter(isLookup)[0]?.instruction).toContain(OPENING);

    // a sitting opens in the player's own image viewer while the rest paint
    await play.enter("/look 1");
    await until(() => play.opened.length === 1);
    expect(await stat(play.opened[0]!)).toBeTruthy();
    await play.enter("/keep 3");
    await play.frame((f) => f.includes("Sitting 3 is not painted yet."));

    later.open();
    await play.frame((f) => f.includes("Pick a sitting · 4 of 4 ready"));
    await play.enter("/keep 2");
    const kept = await play.frame((f) => f.includes("Kept sitting 2.") && f.includes("picture (/look)"));
    expect(kept).not.toContain("Easel");
    await until(async () => (await gitLog(play.campaign))[0] === "illustrate");
    const stamped = (await transcript(play.campaign))[0];
    expect(stamped?.illustration).toBe(opening!.ts);
    expect(painted.map((p) => p.slot).sort()).toEqual([0, 1, 2, 3]);
    await idle(play);

    // /look with no number opens the latest Game Master line's kept picture
    await play.enter("/look");
    await until(() => play.opened.length === 2);
    expect(play.opened[1]).toBe(illustrationAbs(play.campaign, opening!.ts));
    expect(await stat(play.opened[1]!)).toBeTruthy();

    // paint again, then put the brush down: the kept picture stays as it was
    const commits = (await gitLog(play.campaign)).length;
    await play.enter("/illustrate cowboy_shot, 1girl, elf, lake");
    await play.frame((f) => f.includes("Pick a sitting · 4 of 4 ready"));
    expect(painted.slice(4).map((p) => p.prompt)).toEqual(Array(4).fill("cowboy shot, 1girl, elf, lake"));
    await play.enter("/cancel");
    await play.frame((f) => !f.includes("Easel") && f.includes("Idle · 0 turns"));
    await idle(play);
    expect((await gitLog(play.campaign)).length).toBe(commits);
    expect((await transcript(play.campaign))[0]?.illustration).toBe(opening!.ts);
  });

  test("/help, /settings and /set, /log; refusals say why in the web book's words", async () => {
    const localRoot = defaultLocalRuntimeDir();
    const logs = path.join(localRoot, "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, "llama-server.log"), "atomic: model loaded\nslot 0: prompt done\n");
    onCleanup(() => rm(logs, { recursive: true, force: true }));
    // tall enough for /help on one screen
    const play = await openPlay({ height: 60 });

    await play.enter("/nosuch");
    await play.frame((f) => f.includes("Unknown command · /help lists them"));
    await play.enter("/keep 9");
    await play.frame((f) => f.includes("Usage: /keep <1-4>"));
    await play.enter("/help");
    const help = await play.frame((f) => f.includes("Neverending Quest · Commands"));
    for (const usage of ["/retry", "/rolls", "/luck", "/dossiers [seek words]", "/ink", "/settings", "/log [engine|host]"]) {
      expect(help).toContain(usage);
    }
    // a hosted Game Master has no reasoning to cut short; no painter, no brush
    expect(help).not.toContain("/answer");
    expect(help).not.toContain("/illustrate");
    play.setup.mockInput.pressEscape();
    await play.frame((f) => !f.includes("Neverending Quest · Commands"));
    await play.enter("/illustrate");
    await play.frame((f) => f.includes("No painter is set up on this machine."));

    await play.enter("/settings");
    const settings = await play.frame((f) => f.includes("How this book reads and plays · Settings"));
    expect(settings).toMatch(/hygieneN\s+10 turns/u);
    expect(settings).toContain("debug");
    await play.enter("/set hygieneN 3");
    const saved = await play.frame((f) => f.includes("Saved. The next Turn uses these."));
    expect(saved).toMatch(/hygieneN\s+3 turns/u);
    expect(play.surface.config.hygieneN).toBe(3);
    expect(await readFile(path.join(play.root, "config.toml"), "utf8")).toMatch(/3/u);
    await play.enter("/set turnTimeoutSec 0");
    await play.frame((f) => f.includes("turnTimeoutSec must be between 1 and 86400."));
    await play.enter("/set model gpt");
    await play.frame((f) => f.includes("No setting model — /settings lists them."));

    await play.enter("/log");
    const engine = await play.frame((f) => f.includes("Local AI log · Raw inference diagnostics · llama-server.log"));
    expect(engine).toContain("slot 0: prompt done");
    await play.enter("/log host");
    await play.frame((f) => f.includes("No inference host log yet."));
    play.setup.mockInput.pressEscape();
    await play.frame((f) => f.includes(OPENING) && f.includes("Idle · 0 turns"));
  });

  test("a surface with diagnostics off has no AI log and hides its settings", async () => {
    const play = await openPlay({ home: { diagnostics: false } });
    await play.enter("/log");
    await play.frame((f) => f.includes("Diagnostics are off, so there is no AI log."));
    await play.enter("/settings");
    const settings = await play.frame((f) => f.includes("How this book reads and plays · Settings"));
    expect(settings).toContain("hygieneN");
    expect(settings).not.toContain("logPath");
    expect(settings).not.toMatch(/^debug/mu);
  });

  test("a local Game Master: /answer cuts its thinking short; /retry scratch replays the Turn from the player's edit", async () => {
    const host = await startLocalHost({
      defaultRoot: true,
      engine: {
        reasoning: " She owes the ferryman.",
        reply: 'Mira shrugs. "Two strangers, both paid in iron."',
      },
    });
    onCleanup(() => host.stop());
    // `nq play` as src/cli.ts builds it for `llama.cpp/<model>`
    const play = await openPlay({
      factory: await host.gameMaster(),
      config: { model: `llama.cpp/${host.alias}` },
      home: { prepareModel: host.prepareModel, endReasoning: host.endReasoning },
      height: 40,
    });

    await play.enter("Who came in on the ferry?");
    await play.frame((f) => f.includes("She owes the ferryman.") && f.includes("Turning…"));
    expect(host.engine.controls).toEqual([]);
    await play.enter("/answer");
    await play.frame((f) => f.includes("Two strangers, both paid in iron.") && f.includes("Idle · 1 turn"));
    expect(host.engine.controls).toEqual([
      {
        path: "/v1/chat/completions/control",
        body: { id: "chatcmpl-fake-1", action: "reasoning_end" },
      },
    ]);
    await settled(play, "turn 1");
    const firstReply = (await transcript(play.campaign)).at(-1)!;

    await play.enter("/help");
    const help = await play.frame((f) => f.includes("Neverending Quest · Commands"));
    expect(help).toContain("/answer");
    expect(help).toContain("/retry scratch");
    play.setup.mockInput.pressEscape();
    await play.frame((f) => !f.includes("Neverending Quest · Commands"));

    // the Scratch as saved opens for editing; Ctrl+S replays the Turn from it
    await play.enter("/retry scratch");
    await play.frame((f) => f.includes("Ctrl+S retry from this thinking"));
    await play.setup.mockInput.typeText("Mira lies to protect her brother, so ");
    const before = host.engine.completions.length;
    play.setup.mockInput.pressKey("s", { ctrl: true });
    await until(() => host.engine.completions.length > before);
    await play.frame((f) => f.includes("Turning…"));
    await play.enter("/answer");
    await play.frame((f) => f.includes("Idle · 1 turn"));
    await settled(play, "turn 1");
    const sent = host.engine.completions[before]!;
    const messages = sent.messages as Array<Record<string, unknown>>;
    expect(sent.continue_final_message).toBe("reasoning_content");
    expect(messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(String(messages.at(-1)!.reasoning_content)).toMatch(
      /^Mira lies to protect her brother, so Let me think through the scene/u,
    );
    const rows = await transcript(play.campaign);
    expect(rows.filter((r) => r.role === "player")).toHaveLength(1);
    expect(rows.at(-1)!.ts).not.toBe(firstReply.ts);
    expect((await readScratch(play.campaign)).at(-1)?.thinking).toMatch(
      /^Mira lies to protect her brother, so Let me think/u,
    );
  });
});
