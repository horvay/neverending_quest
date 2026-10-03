/**
 * The terminal Home is a stack of screens over one set of widgets: a heading,
 * a status, a list, an optional text line and a key hint. A screen says what
 * to show for the latest Home snapshot and what a choice, a typed line, or
 * Esc does; the runner in `../home.ts` owns the widgets, the keys and the
 * stack.
 */
import {
  isHomeError,
  type HomeLoginPhase,
  type HomeSnapshot,
  type HomeSurface,
} from "../../../home/index.ts";

export type HomeTuiResult = "quit" | "opened";

export type Row = {
  name: string;
  description?: string;
  value: string;
};

export type View = {
  /** The heading line; Home's own title when unset. */
  heading?: string;
  /** Lines under the heading; the sign-in status when unset. */
  status?: string;
  rows: Row[];
  /**
   * A text line under the list. `filter` keeps the list live under it, with
   * ↑↓ moving the list and Enter choosing its row.
   */
  input?: { value: string; placeholder?: string; filter?: boolean };
  hint?: string;
};

export interface HomeScreen {
  view(snap: HomeSnapshot): View;
  /** A row was chosen. */
  choose?(value: string): void | Promise<void>;
  /** Enter on the text line. */
  submit?(text: string): void | Promise<void>;
  /** The text line changed. */
  filter?(text: string): void;
  /** A key while no text line is shown, with the row under the cursor; true when handled. */
  key?(name: string, selected: string | undefined): boolean;
  /** Esc. Leaves the screen when unset. */
  back?(): void | Promise<void>;
  /** The row the cursor was on when the screen was last shown (runner-kept). */
  cursor?: string;
  /** The sign-in phase this screen belongs to (runner-kept). */
  owner?: HomeLoginPhase;
}

export type HomeCtx = {
  readonly surface: HomeSurface;
  /** The latest snapshot. */
  snap(): HomeSnapshot;
  push(screen: HomeScreen): void;
  /** Leave the top screen. */
  pop(): void;
  /** Leave screens from the top while `test` holds for them. */
  popWhile(test: (screen: HomeScreen) => boolean): void;
  /** Back to the hub. */
  toHub(): void;
  repaint(): void;
  /** Show a refusal or failure under the status; cleared on the next move. */
  notice(text: string | undefined): void;
  finish(result: HomeTuiResult): void;
};

/** The surface's own wording for a refusal, or `fallback`. */
export function playerMessage(error: unknown, fallback: string): string {
  return isHomeError(error) ? error.message : fallback;
}

export const BACK: Row = { name: "Back", value: "back" };
