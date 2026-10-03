import { InputRenderableEvents, type CliRenderer } from "@opentui/core";
import type { ScratchRecord } from "../../campaign/types.ts";
import { displayRollReason } from "../../play/dice.ts";
import type { KernelState } from "../../play/kernel.ts";
import { rollHistory } from "../../play/roll_log.ts";
import type { PlayEvent } from "../../play/types.ts";
import { isLlamaCppModel } from "../../model_selector.ts";
import { statusColophon } from "../shared/status.ts";
import {
  allowedWhileBusy,
  helpLines,
  parseSlash,
  type SlashCommand,
} from "./play/commands.ts";
import { BUSY, refusal } from "./play/copy.ts";
import { createBrush } from "./play/brush.ts";
import type { TuiChromeHandlers } from "./play/handlers.ts";
import { createInspect } from "./play/inspect.ts";
import { mountPlayLayout, PLAY_PLACEHOLDER } from "./play/layout.ts";
import {
  dimGmTurns,
  formatHistoryList,
  formatStatus,
  formatStory,
  gmAtTurn,
  lastGmTurn,
  retryRow,
  type LuckView,
} from "./play/story.ts";
import { createSettings } from "./play/settings.ts";
import {
  formatHelp,
  formatRollLog,
  formatView,
  rollNotice,
  viewHint,
  type LeafView,
  type ReadView,
} from "./play/views.ts";

export type { TuiChromeHandlers } from "./play/handlers.ts";

const CONTINUE_HINT = "Later turns leave the line you play [y/N]";
const EDIT_HINT = "Ctrl+S save · Esc cancel";
const INK_HINT = "Ctrl+S set this leaf · Esc leave it";
const SCRATCH_HINT = "Ctrl+S retry from this thinking · Esc cancel";

type ChromeMode =
  | { kind: "play" }
  /** The edit overlay on one transcript row. */
  | { kind: "edit"; ts: string }
  /** The edit overlay on the latest Turn's Scratch, for a retry from it. */
  | { kind: "scratch"; ts: string }
  /** The edit overlay on an Inspect leaf. */
  | { kind: "ink"; leaf: LeafView }
  | { kind: "confirm"; turn: number }
  | { kind: "history" }
  | { kind: "view"; view: ReadView };

const EMPTY: KernelState = {
  phase: "idle",
  story: [],
  draft: "",
  status: "",
  busy: false,
  successTurnCount: 0,
};

/**
 * `nq play`'s play screen: the story, a status line and one input, with
 * slash commands for everything the web book does at the table. Paint it
 * with each new Kernel state, and hand it every PlayEvent (`event`).
 */
export function mountPlayChrome(
  renderer: CliRenderer,
  handlers: TuiChromeHandlers,
): {
  paint: (state: KernelState) => void;
  event: (ev: PlayEvent, state: KernelState) => void;
  unmount: () => void;
} {
  const layout = mountPlayLayout(renderer);
  const { input, overlay } = layout;

  let lastState = EMPTY;
  let mode: ChromeMode = { kind: "play" };
  let notice: string | undefined;
  let inflight = false;
  let dice: string | undefined;
  let luck: LuckView | undefined;
  let mounted = true;
  const openScratchTs = new Set<string>();
  let scratchByTs = new Map<string, ScratchRecord>();
  let historyEntries: Array<{ turn: number; prose: string }> = [];

  const model = () => settings.home?.model ?? "";
  const canEndReasoning = () => model().startsWith("llama.cpp/");
  const canEditScratch = () => isLlamaCppModel(model());
  const busy = () => lastState.busy || inflight;

  // ---- painting ----------------------------------------------------------

  const currentView = (): ReadView | undefined =>
    mode.kind === "view"
      ? mode.view
      : mode.kind === "ink"
        ? { kind: "leaf", leaf: mode.leaf }
        : undefined;

  const statusLine = (state: KernelState): string => {
    if (notice) return notice;
    switch (mode.kind) {
      case "confirm":
        return CONTINUE_HINT;
      case "edit":
        return EDIT_HINT;
      case "ink":
        return INK_HINT;
      case "scratch":
        return SCRATCH_HINT;
      case "history":
        return "Pick a turn · Esc back";
      case "view":
        return viewHint(mode.view);
    }
    return brush.status() ?? formatStatus(state, luck);
  };

  const paint = (state: KernelState) => {
    // reads finish late: the play screen (or the whole terminal) may be gone
    if (!mounted || renderer.isDestroyed) return;
    lastState = state;
    if (mode.kind === "history") {
      layout.showView(formatHistoryList(historyEntries));
    } else {
      const view = currentView();
      if (view) {
        layout.showView(formatView(view));
      } else {
        layout.showStory(
          dimGmTurns(
            formatStory(state, {
              scratchByTs,
              openScratchTs,
              easel: brush.lines(),
            }),
          ),
        );
      }
    }
    layout.setDice(dice);
    layout.setStatus(statusLine(state));
  };

  const repaint = () => paint(lastState);

  /** The notice was given while the Game Master worked; it ends with that work. */
  let noticeWhileBusy = false;
  const say = (text?: string) => {
    notice = text;
    noticeWhileBusy = Boolean(text) && lastState.busy;
    repaint();
  };

  const setMode = (next: ChromeMode) => {
    const overlaid = (m: ChromeMode) =>
      m.kind === "edit" || m.kind === "ink" || m.kind === "scratch";
    const wasOverlay = overlaid(mode);
    mode = next;
    input.placeholder =
      next.kind === "confirm" ? "y/N" : next.kind === "history" ? "Turn number" : PLAY_PLACEHOLDER;
    if (wasOverlay && !overlaid(next)) overlay.close();
    repaint();
  };

  const backToStory = () => {
    notice = undefined;
    setMode({ kind: "play" });
  };

  const openOverlay = (next: ChromeMode, title: string, hint: string, text: string) => {
    notice = undefined;
    mode = next;
    overlay.open({ title, hint, text });
    repaint();
  };

  // ---- reads that keep the status line honest ------------------------------

  const loadLuck = async () => {
    if (!handlers.inspect) return;
    const leaf = await handlers.inspect("status").catch(() => null);
    if (!leaf || !mounted) return;
    const { luckPoints, luckArmed } = statusColophon(leaf.text);
    luck = { points: luckPoints, armed: luckArmed };
    repaint();
  };

  const loadHome = async () => {
    await settings.load();
    await brush.checkReady();
    repaint();
  };

  // ---- Inspect ---------------------------------------------------------------

  const showView = (view: ReadView) => {
    notice = undefined;
    setMode({ kind: "view", view });
  };

  const inspect = createInspect({
    handlers,
    current: currentView,
    show: showView,
    refresh: (view) => {
      // an open ink keeps the text (and hash) it started from, so its save
      // still finds out when the disk moved on under it
      if (mode.kind !== "view") return;
      mode = { kind: "view", view };
      repaint();
    },
    ink: (leaf, title) => openOverlay({ kind: "ink", leaf }, title, INK_HINT, leaf.leaf.text),
    inked: (leaf) => showView({ kind: "leaf", leaf }),
    say,
    busy,
  });

  /** Show a view, or update it in place when the same view is open. */
  const present = (view: ReadView) => {
    const open = mode.kind === "view" ? mode.view : undefined;
    if (open?.kind === "text" && view.kind === "text" && open.name === view.name) {
      mode = { kind: "view", view };
      repaint();
    } else {
      showView(view);
    }
  };

  const settings = createSettings({ handlers, present, say });

  const brush = createBrush({
    handlers,
    state: () => lastState,
    busy,
    locked: async (work: () => Promise<void>) => {
      inflight = true;
      try {
        await work();
      } finally {
        inflight = false;
      }
    },
    toStory: () => backToStory(),
    say,
    repaint,
  });

  const refreshTextView = async () => {
    if (mode.kind !== "view" || mode.view.kind !== "text") return;
    if (mode.view.name === "rolls") await showRolls();
    else if (mode.view.name === "settings") await settings.show();
  };

  // ---- authoring ---------------------------------------------------------------

  /** Run one write at a time; a refusal becomes the notice. */
  const runAuthoring = async (
    work: () => Promise<unknown>,
    copy: (err: unknown) => string = (err) => (err instanceof Error ? err.message : String(err)),
  ) => {
    if (inflight) return;
    inflight = true;
    try {
      await work();
    } catch (err) {
      say(copy(err));
    } finally {
      inflight = false;
    }
  };

  const openEdit = (turn?: number) => {
    const rows = lastState.story;
    const row =
      turn === undefined
        ? rows[rows.length - 1]
        : gmAtTurn(rows, lastState.successTurnCount, turn);
    if (!row) {
      say(turn === undefined ? "Nothing to edit" : `No GM turn ${turn}`);
      return;
    }
    if (!row.ts) {
      say("Nothing to edit");
      return;
    }
    openOverlay({ kind: "edit", ts: row.ts }, "Edit", EDIT_HINT, row.text);
  };

  const saveOverlay = async () => {
    if (inflight) return;
    const text = overlay.text();
    if (mode.kind === "edit") {
      const ts = mode.ts;
      if (!handlers.editTranscript) return backToStory();
      inflight = true;
      try {
        await handlers.editTranscript(ts, text);
        backToStory();
      } catch (err) {
        say(err instanceof Error ? err.message : String(err));
      } finally {
        inflight = false;
      }
    } else if (mode.kind === "ink") {
      const leaf = mode.leaf;
      inflight = true;
      try {
        await inspect.saveInk(leaf, text);
      } finally {
        inflight = false;
      }
    } else if (mode.kind === "scratch") {
      const ts = mode.ts;
      if (!text.trim()) {
        say("Scratch to continue from is empty");
        return;
      }
      backToStory();
      await runAuthoring(() => handlers.retryTranscript!(ts, text), (err) => refusal("retry", err));
    }
  };

  const startConfirm = async (turn?: number, opts?: { checked?: boolean }) => {
    const target = turn ?? lastGmTurn(lastState.story, lastState.successTurnCount);
    if (target === undefined) {
      say("No GM turn");
      return;
    }
    if (turn !== undefined && !opts?.checked) {
      const inStory = Boolean(gmAtTurn(lastState.story, lastState.successTurnCount, turn));
      if (!inStory) {
        const entries = handlers.history ? await handlers.history() : [];
        if (!entries.some((e) => e.turn === turn)) {
          say(`No GM turn ${turn}`);
          return;
        }
      }
    }
    notice = undefined;
    setMode({ kind: "confirm", turn: target });
  };

  const handleConfirm = (answer: string) => {
    if (mode.kind !== "confirm") return;
    const turn = mode.turn;
    const yes = answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
    backToStory();
    if (!yes) return;
    void runAuthoring(
      () => handlers.continueFromTurn?.(turn) ?? Promise.resolve(),
      (err) => refusal("continue", err),
    );
  };

  const handleHistoryPick = (answer: string) => {
    if (!/^\d+$/u.test(answer)) {
      say("Pick a turn");
      return;
    }
    const turn = Number(answer);
    if (!historyEntries.some((e) => e.turn === turn)) {
      say(`No GM turn ${turn}`);
      return;
    }
    void startConfirm(turn, { checked: true });
  };

  const toggleScratch = async (turn?: number) => {
    const target = turn ?? lastGmTurn(lastState.story, lastState.successTurnCount);
    if (target === undefined) {
      say("No GM turn");
      return;
    }
    const gm = gmAtTurn(lastState.story, lastState.successTurnCount, target);
    if (!gm?.ts) {
      say(`No GM turn ${target}`);
      return;
    }
    if (openScratchTs.has(gm.ts)) {
      openScratchTs.delete(gm.ts);
      repaint();
      return;
    }
    const records = handlers.scratch ? await handlers.scratch() : [];
    scratchByTs = new Map(records.map((row) => [row.ts, row]));
    if (!scratchByTs.has(gm.ts)) {
      say("No scratch for that turn");
      return;
    }
    openScratchTs.add(gm.ts);
    backToStory();
  };

  const openHistory = async () => {
    historyEntries = handlers.history ? await handlers.history() : [];
    notice = undefined;
    setMode({ kind: "history" });
  };

  // ---- Retry and Answer now ------------------------------------------------------

  const retry = async (fromScratch: boolean) => {
    const row = retryRow(lastState);
    if (!row?.ts) {
      say("Only the latest Game Master reply can be retried.");
      return;
    }
    if (!fromScratch) {
      backToStory();
      await runAuthoring(() => handlers.retryTranscript!(row.ts!), (err) => refusal("retry", err));
      return;
    }
    if (!canEditScratch()) {
      say("This Game Master cannot continue from edited scratch.");
      return;
    }
    if (row.role !== "gm") {
      say("Only a Game Master reply has Scratch to continue");
      return;
    }
    const records = handlers.scratch ? await handlers.scratch() : [];
    const record = records.find((r) => r.ts === row.ts);
    if (!record) {
      say("No scratch for that turn");
      return;
    }
    openOverlay({ kind: "scratch", ts: row.ts }, "Scratch", SCRATCH_HINT, record.thinking);
  };

  const answerNow = async () => {
    if (!canEndReasoning()) {
      say("Answer now needs a local llama.cpp Game Master.");
      return;
    }
    if (!lastState.busy || lastState.phase === "idle") {
      say("The Game Master is not thinking now.");
      return;
    }
    try {
      if (await handlers.endReasoning?.()) say("Answer requested");
    } catch (err) {
      say(refusal("answer", err));
    }
  };

  // ---- Luck and rolls ---------------------------------------------------------------

  const toggleLuck = async () => {
    if (!luck) await loadLuck();
    if (!luck) return;
    if (!luck.armed && luck.points === 0) {
      say("No luck remains in this Campaign.");
      return;
    }
    const armed = !luck.armed;
    await runAuthoring(async () => {
      await handlers.setLuckArmed?.(armed);
      await loadLuck();
      await inspect.reload();
      // the Status leaf's own words for each side of the switch
      say(
        armed
          ? "The next die will land on its highest face."
          : "Arm one point to max the next roll.",
      );
    }, (err) => refusal("luck", err));
  };

  const showRolls = async () => {
    const records = handlers.scratch ? await handlers.scratch().catch(() => []) : [];
    present({
      kind: "text",
      name: "rolls",
      text: formatRollLog(rollHistory(records)),
      hint: "Esc back",
    });
  };

  // ---- help ----------------------------------------------------------------------------

  const showHelp = () =>
    showView({
      kind: "text",
      name: "help",
      text: formatHelp(
        helpLines({
          answer: canEndReasoning(),
          scratch: canEditScratch(),
          illustrate: brush.ready,
          diagnostics: settings.home?.diagnostics !== false && Boolean(handlers.readLocalLog),
        }),
      ),
      hint: "Esc back",
    });

  // ---- commands ----------------------------------------------------------------------------

  const handleSlash = async (cmd: SlashCommand) => {
    if (busy() && !allowedWhileBusy(cmd)) {
      say(BUSY);
      return;
    }
    notice = undefined;
    switch (cmd.kind) {
      case "quit":
        handlers.quit();
        return;
      case "unknown":
        say("Unknown command · /help lists them");
        return;
      case "usage":
        say(`Usage: ${cmd.usage}`);
        return;
      case "help":
        showHelp();
        return;
      case "stop":
        if (lastState.busy) handlers.interrupt?.();
        else say("The Game Master is not writing now.");
        return;
      case "answer":
        await answerNow();
        return;
      case "retry":
        await retry(cmd.scratch);
        return;
      case "edit":
        openEdit(cmd.turn);
        return;
      case "delete": {
        const last = lastState.story[lastState.story.length - 1];
        backToStory();
        await runAuthoring(() => handlers.deleteTranscript?.(last?.ts) ?? Promise.resolve());
        return;
      }
      case "continue":
        await startConfirm(cmd.turn);
        return;
      case "scratch":
        await runAuthoring(() => toggleScratch(cmd.turn));
        return;
      case "history":
        await runAuthoring(() => openHistory());
        return;
      case "hygiene":
        backToStory();
        await runAuthoring(() => handlers.startHygiene?.(cmd.mode) ?? Promise.resolve());
        return;
      case "luck":
        await toggleLuck();
        return;
      case "rolls":
        await showRolls();
        return;
      case "leaf":
        await inspect.openLeaf(cmd.target);
        return;
      case "dossiers":
        await inspect.openDossiers(cmd.query, cmd.archives);
        return;
      case "dossier":
        await inspect.openLeaf("dossiers", cmd.slug);
        return;
      case "ink":
        inspect.ink();
        return;
      case "new":
        await runAuthoring(() => inspect.create(cmd.name));
        return;
      case "archive":
        await runAuthoring(() => inspect.archive(cmd.slug, cmd.archive));
        return;
      case "illustrate":
        await brush.illustrate(cmd.prompt);
        return;
      case "keep":
        await brush.keep(cmd.slot);
        return;
      case "look":
        await brush.look(cmd.slot);
        return;
      case "cancel":
        await brush.cancel();
        return;
      case "settings":
        await settings.show();
        return;
      case "set":
        await runAuthoring(() => settings.set(cmd.key, cmd.value));
        return;
      case "log":
        await settings.showLog(cmd.source);
        return;
    }
  };

  input.on(InputRenderableEvents.ENTER, () => {
    const value = input.value;
    const trimmed = value.trim();
    if (overlay.visible) return;
    if (mode.kind === "confirm") {
      input.value = "";
      handleConfirm(trimmed);
      return;
    }
    if (mode.kind === "history") {
      input.value = "";
      handleHistoryPick(trimmed);
      return;
    }
    const slash = parseSlash(value);
    if (slash) {
      input.value = "";
      void handleSlash(slash);
      return;
    }
    if (busy()) {
      // keep the line: it can go once the Game Master is done
      say(BUSY);
      return;
    }
    input.value = "";
    backToStory();
    handlers.submit(value);
  });

  overlay.onSave(() => {
    void saveOverlay();
  });

  const onKey = (key: { name?: string; preventDefault?: () => void }) => {
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault?.();
      layout.page(key.name === "pageup" ? -1 : 1);
      return;
    }
    if (key.name !== "escape") return;
    if (mode.kind === "ink") {
      key.preventDefault?.();
      notice = undefined;
      showView({ kind: "leaf", leaf: mode.leaf });
      return;
    }
    if (mode.kind !== "play") {
      key.preventDefault?.();
      backToStory();
      return;
    }
    if (notice) say(undefined);
  };
  renderer.keyInput.on("keypress", onKey);

  // ---- events ----------------------------------------------------------------------------

  const event = (ev: PlayEvent, state: KernelState) => {
    lastState = state;
    switch (ev.type) {
      case "turn_started":
        dice = undefined;
        notice = undefined;
        break;
      case "hygiene_started":
      case "compact_started":
        notice = undefined;
        break;
      case "roll":
        dice = rollNotice({
          n: ev.n,
          value: ev.value,
          ...(ev.reason ? { reason: displayRollReason(ev.reason) } : {}),
        });
        void loadLuck();
        break;
      case "turn_ended":
      case "hygiene_ended":
      case "compact_ended":
      case "story_replaced":
        if (ev.type !== "story_replaced" && noticeWhileBusy) notice = undefined;
        void loadLuck();
        void inspect.reload();
        void refreshTextView();
        break;
    }
    if (ev.type.startsWith("illustrate_") && noticeWhileBusy) notice = undefined;
    brush.event(ev);
    paint(state);
  };

  void loadLuck();
  void loadHome();
  layout.focus();

  const unmount = () => {
    mounted = false;
    renderer.keyInput.off("keypress", onKey);
    layout.unmount();
  };

  return { paint, event, unmount };
}

