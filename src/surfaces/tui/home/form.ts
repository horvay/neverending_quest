/**
 * A form in the terminal: one row per field. Enter on a row edits it — a
 * typed line for text and numbers, a list for a choice — flips a switch, or
 * runs an action. The load page, Settings and the Almanac's entry form are
 * all forms.
 */
import type { HomeSnapshot } from "../../../home/index.ts";
import type { HomeCtx, HomeScreen, Row, View } from "./screen.ts";

/** A typed line that is not a number, where a number belongs. */
export const NOT_A_NUMBER = "Type a number.";

export type Choice = { name: string; value: string; description?: string };

export type Field =
  | {
      kind: "text";
      key: string;
      label: string;
      /** The text being edited. */
      text: string;
      /** What a blank `text` means, shown on the row ("Provider default"). */
      blank?: string;
      /** An example on the empty edit line. */
      placeholder?: string;
      unit?: string;
      help?: string;
      /** What the edit line explains; `help` when unset. */
      detail?: string;
      /** Takes the typed line; a returned message refuses it. */
      set: (text: string) => string | void;
    }
  | {
      kind: "choice";
      key: string;
      label: string;
      value: string;
      choices: Choice[];
      help?: string;
      set: (value: string) => void;
    }
  | { kind: "switch"; key: string; label: string; on: boolean; help?: string; set: (on: boolean) => void }
  | { kind: "action"; key: string; label: string; help?: string; run: () => void | Promise<void> }
  /** A line to read; choosing it does nothing. */
  | { kind: "note"; key: string; label: string; help?: string };

function fieldRow(field: Field): Row {
  switch (field.kind) {
    case "text": {
      const shown = field.text.trim() ? field.text : (field.blank ?? "—");
      return {
        name: `${field.label}: ${shown}${field.unit ? ` ${field.unit}` : ""}`,
        description: field.help ?? "",
        value: field.key,
      };
    }
    case "choice": {
      const chosen = field.choices.find((choice) => choice.value === field.value);
      return {
        name: `${field.label}: ${chosen?.name ?? field.value}`,
        description: field.help ?? "",
        value: field.key,
      };
    }
    case "switch":
      return {
        name: `[${field.on ? "x" : " "}] ${field.label}`,
        description: field.help ?? "",
        value: field.key,
      };
    case "action":
    case "note":
      return { name: field.label, description: field.help ?? "", value: field.key };
  }
}

export type FormSpec = {
  heading: string;
  status?: (snap: HomeSnapshot) => string | undefined;
  fields: (snap: HomeSnapshot) => Field[];
  hint?: string;
  /** Esc; leaves the form when unset. */
  back?: () => void | Promise<void>;
};

export class FormScreen implements HomeScreen {
  constructor(
    private readonly ctx: HomeCtx,
    private readonly spec: FormSpec,
  ) {}

  view(snap: HomeSnapshot): View {
    return {
      heading: this.spec.heading,
      status: this.spec.status?.(snap) ?? "",
      rows: this.spec.fields(snap).map(fieldRow),
      hint: this.spec.hint ?? "↑↓ move · Enter change · Esc back",
    };
  }

  async choose(value: string): Promise<void> {
    const field = this.spec.fields(this.ctx.snap()).find((item) => item.key === value);
    if (!field) return;
    switch (field.kind) {
      case "text":
        this.ctx.push(new EditScreen(this.ctx, field));
        return;
      case "choice":
        this.ctx.push(new ChoiceScreen(this.ctx, field));
        return;
      case "switch":
        field.set(!field.on);
        this.ctx.repaint();
        return;
      case "action":
        await field.run();
        this.ctx.repaint();
        return;
      case "note":
        return;
    }
  }

  back(): void | Promise<void> {
    if (this.spec.back) return this.spec.back();
    this.ctx.pop();
  }
}

/** One text or number field, typed on the line under the list. */
export class EditScreen implements HomeScreen {
  constructor(
    private readonly ctx: HomeCtx,
    private readonly field: Extract<Field, { kind: "text" }>,
  ) {}

  view(): View {
    const { field } = this;
    return {
      heading: field.label,
      status: [field.detail ?? field.help, field.unit ? `In ${field.unit}.` : ""]
        .filter(Boolean)
        .join("\n"),
      rows: [],
      input: { value: field.text, placeholder: field.placeholder ?? "" },
      hint: "Enter set · Ctrl+U clear · Esc cancel",
    };
  }

  submit(text: string): void {
    const refused = this.field.set(text);
    if (refused) {
      this.ctx.notice(refused);
      return;
    }
    this.ctx.pop();
  }
}

/** One choice field, picked from a list. */
export class ChoiceScreen implements HomeScreen {
  constructor(
    private readonly ctx: HomeCtx,
    private readonly field: Extract<Field, { kind: "choice" }>,
  ) {
    this.cursor = field.value;
  }

  cursor?: string;

  view(): View {
    const { field } = this;
    return {
      heading: field.label,
      status: field.help ?? "",
      rows: field.choices.map((choice) => ({
        name: `${choice.value === field.value ? "• " : "  "}${choice.name}`,
        description: choice.description ?? "",
        value: `choice:${choice.value}`,
      })),
      hint: "↑↓ move · Enter choose · Esc back",
    };
  }

  choose(value: string): void {
    if (!value.startsWith("choice:")) return;
    this.field.set(value.slice("choice:".length));
    this.ctx.pop();
  }
}
