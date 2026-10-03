import * as readline from "node:readline";

export type TerminalChoice = {
  value: string;
  label: string;
};

export type PickerInput =
  | { type: "up" | "down" | "backspace" | "enter" | "escape" }
  | { type: "text"; text: string };

export type PickerResult =
  | { type: "pending" }
  | { type: "selected"; value: string }
  | { type: "cancelled" };

const VISIBLE_CHOICES = 8;
const INVERSE = "\u001B[7m";
const RESET = "\u001B[0m";

/**
 * Stateful, searchable list navigation. The terminal adapter owns raw-mode IO;
 * this module owns filtering, focus movement, and rendering.
 */
export class TerminalPicker {
  private query = "";
  private selectedIndex = 0;

  constructor(
    private readonly title: string,
    private readonly options: TerminalChoice[],
  ) {}

  handle(input: PickerInput): PickerResult {
    const matches = this.matches();
    switch (input.type) {
      case "up":
        if (matches.length > 0) {
          this.selectedIndex =
            (this.selectedIndex + matches.length - 1) % matches.length;
        }
        return { type: "pending" };
      case "down":
        if (matches.length > 0) {
          this.selectedIndex = (this.selectedIndex + 1) % matches.length;
        }
        return { type: "pending" };
      case "backspace":
        this.query = Array.from(this.query).slice(0, -1).join("");
        this.selectedIndex = 0;
        return { type: "pending" };
      case "text":
        this.query += input.text;
        this.selectedIndex = 0;
        return { type: "pending" };
      case "enter":
        return matches.length === 0
          ? { type: "pending" }
          : { type: "selected", value: matches[this.selectedIndex]!.value };
      case "escape":
        return { type: "cancelled" };
    }
  }

  render(): string {
    const matches = this.matches();
    const lines = [
      this.title,
      `Search: ${this.query || "…"}`,
      `${matches.length} match${matches.length === 1 ? "" : "es"} · ↑↓ move · Enter select · Esc cancel`,
    ];
    if (matches.length === 0) {
      lines.push("  No matching options");
      return `${lines.join("\n")}\n`;
    }

    const start = Math.min(
      Math.max(0, this.selectedIndex - Math.floor(VISIBLE_CHOICES / 2)),
      Math.max(0, matches.length - VISIBLE_CHOICES),
    );
    const visible = matches.slice(start, start + VISIBLE_CHOICES);
    for (const [offset, choice] of visible.entries()) {
      const index = start + offset;
      const row = `> ${choice.label} (${choice.value})`;
      lines.push(index === this.selectedIndex ? `${INVERSE}${row}${RESET}` : `  ${row.slice(2)}`);
    }
    if (matches.length > start + visible.length) lines.push("  …");
    return `${lines.join("\n")}\n`;
  }

  private matches(): TerminalChoice[] {
    const terms = this.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.options;
    return this.options.filter((choice) => {
      const searchable = `${choice.label} ${choice.value}`.toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }
}

export async function selectInteractiveChoice(
  title: string,
  options: TerminalChoice[],
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("`nq login` requires an interactive terminal.");
  }
  if (options.length === 0) throw new Error("No options are available.");

  const picker = new TerminalPicker(title, options);
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  let renderedLines = 0;

  const clear = () => {
    if (renderedLines > 0) output.write(`\u001B[${renderedLines}A\u001B[J`);
  };
  const draw = () => {
    clear();
    const content = picker.render();
    renderedLines = content.split("\n").length - 1;
    output.write(content);
  };

  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  draw();

  return new Promise<string>((resolve, reject) => {
    const finish = (result: PickerResult) => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      clear();
      output.write("\n");
      if (result.type === "selected") resolve(result.value);
      else reject(new Error("Selection cancelled."));
    };
    const onKeypress = (text: string, key: Keypress) => {
      const result = picker.handle(toPickerInput(text, key));
      if (result.type === "pending") draw();
      else finish(result);
    };
    input.on("keypress", onKeypress);
  });
}

type Keypress = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
};

function toPickerInput(text: string, key: Keypress): PickerInput {
  if (key.name === "up") return { type: "up" };
  if (key.name === "down") return { type: "down" };
  if (key.name === "backspace") return { type: "backspace" };
  if (key.name === "return" || key.name === "enter") return { type: "enter" };
  if (key.name === "escape" || (key.ctrl && key.name === "c")) {
    return { type: "escape" };
  }
  return { type: "text", text: key.ctrl || key.meta ? "" : text };
}
