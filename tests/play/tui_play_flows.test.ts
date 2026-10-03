import { describe, expect, test } from "bun:test";
import path from "node:path";
import { says } from "../helpers/game_master.ts";
import {
  OPENING,
  gated,
  gitLog,
  openPlay,
  settled,
  storyOf,
  transcript,
  until,
} from "../helpers/tui.ts";

/**
 * `nq play <campaign>` end to end: the OpenTUI play client (run_play +
 * tui_chrome) over the real HomeSurface, PlaySession, PlayLoop, OMP agent,
 * Campaign tools and a real Campaign folder with git. Only the model (the
 * scripted Game Master) and the terminal (OpenTUI's test renderer) are fake.
 */

describe("nq play (OpenTUI) over a real Campaign", () => {
  test("a typed action streams the Game Master's reply into the story and commits the Turn", async () => {
    const hold = gated();
    const play = await openPlay({
      steps: [
        async (c) => {
          c.say("Mira looks at ");
          await hold.wait;
          c.say("your hands, not your face.");
        },
      ],
    });
    const opening = play.setup.captureCharFrame();
    expect(opening).toContain("GM  0");
    expect(opening).toContain(OPENING);
    expect(opening).toContain("Idle · 0 turns");

    await play.enter("I nod to Mira.");
    const streaming = await play.frame(
      (f) => f.includes("Mira looks at") && f.includes("Turning…"),
    );
    expect(streaming).toContain("I nod to Mira.");
    expect(streaming).not.toContain("your hands");
    expect(play.gm.calls[0]?.prompt).toBe("I nod to Mira.");

    // while the Game Master writes, a write command is refused: it reaches
    // neither the Campaign nor the Game Master
    await play.enter("/delete");
    await play.frame((f) => f.includes("Busy — try again when Idle."));
    expect(play.gm.calls).toHaveLength(1);

    hold.open();
    const done = await play.frame(
      (f) => f.includes("your hands, not your face.") && f.includes("Idle · 1 turn"),
    );
    expect(done).toMatch(/GM {2}1[\s\S]*Mira looks at your hands, not your face\./u);
    await settled(play, "turn 1");
    expect((await transcript(play.campaign)).map((r) => [r.role, r.text])).toEqual([
      ["gm", OPENING],
      ["player", "I nod to Mira."],
      ["gm", "Mira looks at your hands, not your face."],
    ]);

    // an empty Enter is still the player's move: (continue)
    await play.enter("");
    await play.frame((f) => f.includes("GM  2") && f.includes("Idle · 2 turns"));
    expect(play.gm.calls[1]?.prompt).toBe("(continue)");
    expect((await transcript(play.campaign))[3]).toMatchObject({
      role: "player",
      text: "(continue)",
    });
  });

  test("Stop keeps the reply so far; SIGINT while idle leaves for Home", async () => {
    const play = await openPlay({
      steps: [
        async (c) => {
          c.say("The rope creaks and");
          await c.aborted();
        },
      ],
    });
    await play.enter("I climb the rope.");
    await play.frame((f) => f.includes("The rope creaks and") && f.includes("Turning…"));

    play.sigint();
    const stopped = await play.frame(
      (f) => f.includes("Idle · 1 turn") && f.includes("GM  1"),
    );
    expect(stopped).toMatch(/GM {2}1[\s\S]*The rope creaks and/u);
    await settled(play, "turn 1");
    const rows = await transcript(play.campaign);
    expect(rows.at(-1)).toMatchObject({ role: "gm", text: "The rope creaks and" });
    expect(play.gm.calls[0]?.signal?.aborted).toBe(true);

    // idle: the same signal leaves the Campaign for Home, and Esc there ends nq play
    await until(() => play.surface.play?.loop.loopState === "idle");
    play.sigint();
    await play.frame((f) => f.includes("New adventure"));
    expect(play.surface.play).toBeNull();
    play.setup.mockInput.pressEscape();
    expect(await play.running).toBe(0);
  });

  test("/edit opens the row in an overlay; Esc cancels and Ctrl+S saves into the Campaign", async () => {
    const play = await openPlay({});
    await play.enter("/edit");
    const overlay = await play.frame((f) => f.includes("Ctrl+S save"));
    expect(overlay).toContain("Edit");
    expect(overlay).toContain("Esc cancel");

    play.setup.mockInput.pressEscape();
    await play.frame((f) => !f.includes("Ctrl+S save") && f.includes("Idle"));
    expect(await gitLog(play.campaign)).toEqual(["opening", "birth"]);

    await play.enter("/edit 0");
    await play.frame((f) => f.includes("Ctrl+S save"));
    await play.setup.mockInput.typeText("Lamp lit. ");
    play.setup.mockInput.pressKey("s", { ctrl: true });
    const saved = await play.frame(
      (f) => !f.includes("Ctrl+S save") && f.includes("Lamp lit."),
    );
    expect(saved).toContain("Idle · 0 turns");
    const rows = await transcript(play.campaign);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toContain("Lamp lit.");
    expect(rows[0]?.text).toContain("Mira Venn watches you");
    expect(await gitLog(play.campaign)).toContain("edit");

    // the Game Master's next Turn reads the edited line, not the old one
    await play.enter("I nod.");
    await play.frame((f) => f.includes("Idle · 1 turn"));
    const seen = JSON.stringify(play.gm.calls[0]?.context.messages);
    expect(seen).toContain("Lamp lit.");
  });

  test("bare /edit after a failed Turn edits the player's line", async () => {
    const play = await openPlay({
      steps: [
        () => {
          throw new Error("provider is down");
        },
      ],
    });
    await play.enter("I nod to Mira.");
    // a failed Turn says so instead of going quietly Idle
    await play.frame(
      (f) => f.includes("I nod to Mira.") && f.includes("The Game Master finished without replying"),
    );
    await until(() => play.surface.play?.loop.loopState === "idle");
    await play.enter("/edit");
    await play.frame((f) => f.includes("Ctrl+S save"));
    await play.setup.mockInput.typeText("Warmly: ");
    play.setup.mockInput.pressKey("s", { ctrl: true });
    await play.frame((f) => !f.includes("Ctrl+S save") && f.includes("Warmly:"));
    const rows = await transcript(play.campaign);
    expect(rows.map((r) => r.role)).toEqual(["gm", "player"]);
    expect(rows[1]?.text).toContain("Warmly:");
    expect(rows[1]?.text).toContain("I nod to Mira.");
  });

  test("a save that fails stays on the overlay with the reason", async () => {
    const play = await openPlay({});
    await play.enter("/edit");
    await play.frame((f) => f.includes("Ctrl+S save"));
    // the row goes away on disk while the overlay is open (a hand edit)
    const file = path.join(play.campaign, "transcript.jsonl");
    const [row] = await transcript(play.campaign);
    await Bun.write(file, `${JSON.stringify({ ...row, ts: "2026-01-01T00:00:00.000Z" })}\n`);
    await play.setup.mockInput.typeText("Lamp lit. ");
    play.setup.mockInput.pressKey("s", { ctrl: true });
    const failed = await play.frame((f) => f.includes("No transcript row"));
    expect(failed).toContain("Ctrl+S save");
    expect(await gitLog(play.campaign)).toEqual(["opening", "birth"]);
    expect((await transcript(play.campaign))[0]?.text).not.toContain("Lamp lit.");
  });

  test("/continue asks y/N first; a yes rewinds to that Turn and the Game Master extends it", async () => {
    const play = await openPlay({
      steps: [
        says("Mira looks at your hands."),
        says("She sets her lamp on the rail."),
      ],
    });
    await play.enter("I nod to Mira.");
    await play.frame((f) => f.includes("Idle · 1 turn"));
    await settled(play, "turn 1");

    await play.enter("/continue");
    await play.frame((f) => f.includes("Later turns leave the line you play"));
    await play.enter(""); // N is the default
    await play.frame((f) => f.includes("Idle · 1 turn"));
    expect(play.gm.calls).toHaveLength(1);

    await play.enter("/continue 99");
    const missing = await play.frame((f) => f.includes("No GM turn 99"));
    expect(missing).not.toContain("Later turns leave the line you play");

    await play.enter("/continue 0");
    await play.frame((f) => f.includes("Later turns leave the line you play"));
    await play.enter("Y");
    const extended = await play.frame(
      (f) => f.includes("She sets her lamp on the rail.") && f.includes("Idle · 0 turns"),
    );
    expect(storyOf(extended)).not.toContain("I nod to Mira.");
    expect(storyOf(extended)).not.toContain("Mira looks at your hands.");
    expect(play.gm.calls[1]?.prompt).toContain("[Continue — same Game Master line]");
    expect(play.gm.calls[1]?.prompt).toContain("Salt Lamp doorway.");
    await until(async () => (await gitLog(play.campaign))[0] === "continue 0");
    const rows = await transcript(play.campaign);
    expect(rows.map((r) => r.role)).toEqual(["gm"]);
    expect(rows[0]?.text).toMatch(
      /^Mira Venn watches you from the Salt Lamp doorway\.\s+She sets her lamp on the rail\.$/u,
    );
  });

  test("/history lists every GM Turn and a pick is the same Continue confirm", async () => {
    const play = await openPlay({
      steps: [says("Mira looks at your hands."), says("then at the door.")],
    });
    await play.enter("I nod to Mira.");
    await play.frame((f) => f.includes("Idle · 1 turn"));
    await settled(play, "turn 1");

    await play.enter("/history");
    const list = await play.frame((f) => f.includes("Pick a turn · Esc back"));
    expect(list).toContain(`0 · ${OPENING}`);
    expect(list).toContain("1 · Mira looks at your hands.");

    await play.enter("nine");
    await play.frame((f) => f.includes("Pick a turn") && !f.includes("Esc back"));
    await play.enter("1");
    await play.frame((f) => f.includes("Later turns leave the line you play"));
    await play.enter("yes");
    const extended = await play.frame(
      (f) => f.includes("then at the door.") && f.includes("Idle · 1 turn"),
    );
    expect(extended).toMatch(/GM {2}1[\s\S]*Mira looks at your hands\.[\s\S]*then at the door\./u);
    await until(async () => (await gitLog(play.campaign))[0] === "continue 1");
    const rows = await transcript(play.campaign);
    expect(rows).toHaveLength(3);
    expect(rows.at(-1)?.text).toMatch(/^Mira looks at your hands\.\s+then at the door\.$/u);
  });

  test("/scratch shows the Turn's thinking and tools under its GM block; /delete rewinds the Turn", async () => {
    const hold = gated();
    const play = await openPlay({
      steps: [
        (c) => {
          c.think("Price is a chore, not coin.");
          // Play Turns only read and roll; OMP runs both for real
          c.tool("read", { path: "player_sheet.md" });
          c.tool("roll", { n: 20 });
        },
        async (c) => {
          await hold.wait;
          c.say("Mira looks at your hands.");
        },
      ],
    });
    await play.enter("I ask Mira her price.");
    const live = await play.frame(
      (f) => f.includes("Price is a chore") && f.includes("roll 20 →") && f.includes("Turning…"),
    );
    expect(live).toContain("Scratch");
    expect(live).toContain("read player_sheet.md");
    // the sheet the tool read reached the Game Master, not the story
    await until(() => play.gm.calls.length === 2);
    // (OMP runs the two calls concurrently, so results arrive in either order)
    const results = play.gm.calls[1]!.toolResults;
    expect(results.map((r) => r.name).sort()).toEqual(["read", "roll"]);
    expect(results.find((r) => r.name === "read")?.text).toContain("A weary ranger.");
    expect(storyOf(live)).not.toContain("A weary ranger.");
    const rolled = results.find((r) => r.name === "roll")?.text.match(/\d+/u)?.[0];
    expect(rolled).toBeDefined();
    hold.open();

    const idle = await play.frame((f) => f.includes("Idle · 1 turn"));
    expect(idle).not.toContain("Price is a chore");
    await settled(play, "turn 1");

    await play.enter("/scratch");
    const open = await play.frame((f) => f.includes("Price is a chore"));
    expect(open).toContain("Scratch");
    expect(open).toContain("read player_sheet.md");
    expect(open).toContain(`roll 20 → ${rolled}`);
    expect(open.indexOf("Mira looks at your hands.")).toBeLessThan(
      open.indexOf("Price is a chore"),
    );
    await play.enter("/scratch 1");
    await play.frame((f) => !f.includes("Price is a chore") && f.includes("Idle"));
    await play.enter("/scratch 0");
    await play.frame((f) => f.includes("No scratch for that turn"));

    await play.enter("/delete");
    const deleted = await play.frame(
      (f) => !f.includes("I ask Mira her price.") && f.includes("Idle · 0 turns"),
    );
    expect(deleted).toContain(OPENING);
    expect(deleted).not.toContain("Mira looks at your hands.");
    expect((await transcript(play.campaign)).map((r) => r.role)).toEqual(["gm"]);
    // the Turn's scratch and turn count went with it
    const scratch = await Bun.file(path.join(play.campaign, ".nq/scratch.jsonl"))
      .text()
      .catch(() => "");
    expect(scratch).not.toContain("Price is a chore");
    await play.enter("/scratch 1");
    await play.frame((f) => f.includes("No GM turn 1"));
  });

  test("/light /heavy /compact /fresh run Memory Hygiene as hidden Game Master passes", async () => {
    const hold = gated();
    const play = await openPlay({
      steps: [
        says("Mira looks at your hands."),
        async (c) => {
          await hold.wait;
          c.tool("write", {
            path: "story-beats.md",
            content: "- Ren nodded to Mira at the Salt Lamp.\n",
          });
        },
      ],
      fallback: says("Noted."),
    });
    await play.enter("I nod to Mira.");
    await play.frame((f) => f.includes("Idle · 1 turn"));
    await settled(play, "turn 1");

    await play.enter("/light");
    await play.frame((f) => f.includes("Memory hygiene…"));
    hold.open();
    await until(async () => (await gitLog(play.campaign))[0] === "light");
    expect(play.gm.calls[1]!.instruction).toContain("[Memory Hygiene — light — hidden system pass]");
    expect(await Bun.file(path.join(play.campaign, "story-beats.md")).text()).toContain(
      "Ren nodded to Mira",
    );
    await play.frame((f) => f.includes("Idle · 1 turn"));

    for (const mode of ["heavy", "compact", "fresh"] as const) {
      const before = play.gm.calls.length;
      await until(() => play.surface.play?.loop.loopState === "idle");
      await play.enter(`/${mode}`);
      await until(async () => (await gitLog(play.campaign))[0] === mode);
      expect(play.gm.calls[before]!.instruction).toContain("[Memory Hygiene — heavy — hidden system pass]");
      await play.frame((f) => f.includes("Idle · 1 turn"));
    }
    // hidden passes never become story
    const rows = await transcript(play.campaign);
    expect(rows.map((r) => r.text)).not.toContain("Noted.");
    expect(storyOf(play.setup.captureCharFrame())).not.toContain("Noted.");
  });

  test("an unknown command is a notice, cleared by the next move; /bye leaves for Home", async () => {
    const play = await openPlay({});
    await play.enter("/nosuch");
    await play.frame((f) => f.includes("Unknown command"));
    expect(play.gm.calls).toHaveLength(0);

    await play.enter("I nod to Mira.");
    const after = await play.frame((f) => f.includes("Idle · 1 turn"));
    expect(after).not.toContain("Unknown command");
    expect(play.gm.calls[0]?.prompt).toBe("I nod to Mira.");

    await until(() => play.surface.play?.loop.loopState === "idle");
    await play.enter("/bye");
    const home = await play.frame((f) => f.includes("New adventure"));
    expect(home).toContain("Neverending Quest");
    expect(play.surface.play).toBeNull();
    await settled(play, "turn 1");
    play.setup.mockInput.pressEscape();
    expect(await play.running).toBe(0);
  });
});
