/**
 * The terminal Home: a stack of screens (`./home/*`) over one set of OpenTUI
 * widgets. The runner keeps the stack in step with the surface — each
 * sign-in phase shows its own screen while it lasts — and routes keys:
 * ↑↓ and Enter to the list or the text line, Esc back, Ctrl+C leave.
 */
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import {
  PLAYER_FAILURE,
  type HomeLoginPhase,
  type HomeSnapshot,
  type HomeSurface,
} from "../../home/index.ts";
import { HubScreen } from "./home/hub.ts";
import { localMemory } from "./home/local_load.ts";
import {
  playerMessage,
  type HomeCtx,
  type HomeScreen,
  type HomeTuiResult,
  type View,
} from "./home/screen.ts";
import { phaseScreen } from "./home/sign_in.ts";

export type { HomeTuiResult };

const TITLE = "Neverending Quest";

export async function runHomeTui(
  renderer: CliRenderer,
  surface: HomeSurface,
): Promise<HomeTuiResult> {
  await surface.refreshLocal();
  let snap = await surface.snapshot();
  let closed = false;
  let notice: string | undefined;
  let phase: HomeLoginPhase = "idle";
  /** The screen and view last drawn. */
  let shown: HomeScreen | undefined;
  let shownView: View | undefined;
  const memory = localMemory();

  const root = new BoxRenderable(renderer, {
    id: "home-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    padding: 1,
  });
  const title = new TextRenderable(renderer, { id: "home-title", content: TITLE, height: 1 });
  const status = new TextRenderable(renderer, {
    id: "home-status",
    content: "",
    width: "100%",
    wrapMode: "word",
  });
  const noticeLine = new TextRenderable(renderer, {
    id: "home-notice",
    content: "",
    width: "100%",
    wrapMode: "word",
    fg: "#ff8a80",
    visible: false,
  });
  const select = new SelectRenderable(renderer, {
    id: "home-select",
    flexGrow: 1,
    showDescription: true,
    wrapSelection: true,
    options: [],
  });
  const input = new InputRenderable(renderer, {
    id: "home-input",
    width: "100%",
    visible: false,
    placeholder: "",
  });
  const hint = new TextRenderable(renderer, { id: "home-hint", content: "", height: 1 });
  root.add(title);
  root.add(status);
  root.add(noticeLine);
  root.add(select);
  root.add(input);
  root.add(hint);
  renderer.root.add(root);

  const done = Promise.withResolvers<HomeTuiResult>();
  const stack: HomeScreen[] = [];

  const finish = (result: HomeTuiResult) => {
    if (closed) return;
    closed = true;
    surface.onChange = undefined;
    process.off("SIGINT", onInt);
    renderer.keyInput.off("keypress", onKey);
    try {
      renderer.root.remove(root);
    } catch {
      // ignore
    }
    done.resolve(result);
  };

  /** Draw the top screen for the snapshot in hand. */
  const draw = () => {
    if (closed || renderer.isDestroyed) return;
    const top = stack.at(-1)!;
    const view = top.view(snap);
    const fresh = top !== shown;
    const before = select.getSelectedOption()?.value as string | undefined;
    const beforeIndex = select.getSelectedIndex();
    if (fresh && shown) shown.cursor = before;

    title.content = view.heading ?? TITLE;
    status.content = view.status ?? statusLine(snap);
    noticeLine.content = notice ?? "";
    noticeLine.visible = Boolean(notice);
    select.options = view.rows.map((row) => ({
      name: row.name,
      description: row.description ?? "",
      value: row.value,
    }));
    const want = fresh ? top.cursor : before;
    const at = view.rows.findIndex((row) => row.value === want);
    select.selectedIndex =
      at >= 0 ? at : fresh ? 0 : Math.max(0, Math.min(beforeIndex, view.rows.length - 1));
    if (view.input) {
      input.visible = true;
      input.placeholder = view.input.placeholder ?? "";
      if (fresh || !shownView?.input) input.value = view.input.value;
      input.focusable = true;
      input.focus();
    } else {
      input.visible = false;
      input.focusable = false;
      select.focus();
    }
    hint.content = view.hint ?? "↑↓ move · Enter select · Esc back · Ctrl+C leave";
    shown = top;
    shownView = view;
  };

  /** Keep the stack in step with the surface's sign-in phase. */
  const follow = (next: HomeLoginPhase) => {
    if (next === phase) return;
    const left = phase;
    phase = next;
    const at = stack.findIndex((screen) => screen.owner === left);
    if (at > 0) stack.splice(at);
    const screen = phaseScreen(ctx, next, memory);
    if (screen) {
      screen.owner = next;
      stack.push(screen);
    } else if (next === "idle" && at > 0) {
      // signed in, or the sign-in was cancelled: back to the hub
      stack.splice(1);
    }
  };

  const paint = async () => {
    snap = await surface.snapshot();
    if (closed || renderer.isDestroyed) return;
    if (snap.open) {
      finish("opened");
      return;
    }
    follow(snap.login.phase);
    draw();
  };

  let painting: Promise<void> | null = null;
  let again = false;
  const repaint = () => {
    if (closed) return;
    if (painting) {
      again = true;
      return;
    }
    painting = (async () => {
      do {
        again = false;
        try {
          await paint();
        } catch (error) {
          notice = playerMessage(error, PLAYER_FAILURE.openFailed);
          draw();
        }
      } while (again && !closed);
      painting = null;
    })();
  };

  const ctx: HomeCtx = {
    surface,
    snap: () => snap,
    push: (screen) => {
      screen.owner ??= stack.at(-1)?.owner;
      stack.push(screen);
      notice = undefined;
      repaint();
    },
    pop: () => {
      if (stack.length > 1) stack.pop();
      notice = undefined;
      repaint();
    },
    popWhile: (test) => {
      while (stack.length > 1 && test(stack.at(-1)!)) stack.pop();
      notice = undefined;
      repaint();
    },
    toHub: () => {
      stack.splice(1);
      notice = undefined;
      repaint();
    },
    repaint,
    notice: (text) => {
      notice = text;
      draw();
    },
    finish,
  };

  /** Run a player's action; a refusal shows in the surface's words. */
  const act = async (run: () => void | Promise<void>) => {
    if (closed) return;
    notice = undefined;
    try {
      await run();
    } catch (error) {
      notice = playerMessage(error, PLAYER_FAILURE.openFailed);
    }
    if (!closed) draw();
  };

  const leave = (screen: HomeScreen) => (screen.back ? screen.back() : ctx.pop());

  const onInt = () => {
    if (stack.length === 1 && phase === "idle") {
      finish("quit");
      return;
    }
    surface.cancelLogin();
    ctx.toHub();
  };
  process.on("SIGINT", onInt);

  const onKey = (key: { name?: string }) => {
    if (closed || !shown) return;
    const screen = stack.at(-1)!;
    if (key.name === "escape") {
      void act(() => leave(screen));
      return;
    }
    if (shownView?.input?.filter && (key.name === "up" || key.name === "down")) {
      if (key.name === "up") select.moveUp();
      else select.moveDown();
      return;
    }
    if (!shownView?.input && key.name && screen.key) {
      const selected = select.getSelectedOption()?.value as string | undefined;
      screen.key(key.name, selected);
    }
  };
  renderer.keyInput.on("keypress", onKey);

  const choose = (value: string) => {
    const screen = stack.at(-1)!;
    void act(() => (value === "back" ? leave(screen) : screen.choose?.(value)));
  };

  select.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    const row = select.options[index];
    if (row && !closed) choose(String(row.value ?? ""));
  });
  input.on(InputRenderableEvents.INPUT, (value: string) => {
    if (!shownView?.input?.filter) return;
    stack.at(-1)!.filter?.(value);
    draw();
    // a new search starts at its first match
    select.selectedIndex = 0;
  });
  input.on(InputRenderableEvents.ENTER, () => {
    const screen = stack.at(-1)!;
    if (shownView?.input?.filter) {
      const row = select.getSelectedOption();
      if (row?.value) choose(String(row.value));
      return;
    }
    const text = input.value;
    void act(() => screen.submit?.(text));
  });

  surface.onChange = repaint;
  stack.push(new HubScreen(ctx));
  follow(snap.login.phase);
  draw();
  repaint();
  return done.promise;
}

function statusLine(snap: HomeSnapshot): string {
  if (snap.login.phase !== "idle" && snap.login.message) return snap.login.message;
  if (snap.signedIn) {
    const model = snap.signedIn.model ? ` · ${snap.signedIn.model}` : "";
    return `Signed in: ${snap.signedIn.provider}${model}`;
  }
  const connected = [...snap.providers.featured, ...snap.providers.more].some(
    (provider) => provider.connected,
  );
  return connected ? "Choose which account the Game Master plays with." : "Sign in to play.";
}
