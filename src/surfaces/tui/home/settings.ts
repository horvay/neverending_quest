/**
 * Settings in the terminal: the web book's Settings fields, less the ones
 * this surface fixes, with the local model's own fields only while the model
 * is local. Numbers are kept as typed; the surface checks the whole form on
 * Save and its refusal is shown as it words it.
 */
import { LOCAL_PROVIDER_ID, type HomeSettings } from "../../../home/index.ts";
import { partialNumber, REASONING_LEVELS } from "../../../home/fields.ts";
import { type Field, FormScreen } from "./form.ts";
import { type HomeCtx, playerMessage } from "./screen.ts";

type TextKey = {
  [K in keyof HomeSettings]-?: HomeSettings[K] extends string ? K : never;
}[keyof HomeSettings];
type NumberKey = {
  [K in keyof HomeSettings]-?: HomeSettings[K] extends number ? K : never;
}[keyof HomeSettings];

export function openSettings(ctx: HomeCtx): void {
  const snap = ctx.snap();
  const draft: HomeSettings = { ...snap.settings };
  // numbers as typed, so a half-typed or wrong value reaches the surface's check
  const typed: Partial<Record<NumberKey, string>> = {};
  const open = (key: keyof HomeSettings) => !snap.fixedSettings.includes(key);

  const text = (
    key: TextKey,
    label: string,
    opts: { help?: string; placeholder?: string; blank?: string } = {},
  ): Field => ({
    kind: "text",
    key,
    label,
    text: draft[key],
    ...opts,
    set: (value) => {
      draft[key] = value;
    },
  });
  const number = (
    key: NumberKey,
    label: string,
    opts: { help?: string; unit?: string } = {},
  ): Field => ({
    kind: "text",
    key,
    label,
    text: typed[key] ?? String(draft[key]),
    ...opts,
    set: (value) => {
      typed[key] = value.trim();
    },
  });

  const fields = (): Field[] => {
    const local = draft.model.trim().startsWith(`${LOCAL_PROVIDER_ID}/`);
    const all: Array<Field | false> = [
      open("model") &&
        text("model", "Model", {
          help: "Use Accounts on Home when a model needs sign-in.",
          placeholder: "provider/model",
        }),
      open("gmPersonality") &&
        text("gmPersonality", "GM personality", {
          help: "Additional character and temperament for the Game Master.",
          placeholder: "Dry, observant, and fond of difficult bargains.",
        }),
      local &&
        open("localThinkingOpener") &&
        text("localThinkingOpener", "Local thinking opener", {
          help: "Starts the first reasoning block of each turn when the local model supports reasoning continuation. Blank uses the built-in numbered step-by-step opener.",
          placeholder: "First, examine the relationships among the characters here and check whether enough is known about each of them.",
        }),
      open("reasoning") && {
        kind: "choice",
        key: "reasoning",
        label: "Reasoning",
        value: draft.reasoning,
        choices: [
          ...(REASONING_LEVELS.includes(draft.reasoning as (typeof REASONING_LEVELS)[number])
            ? []
            : [{ name: draft.reasoning, value: draft.reasoning }]),
          ...REASONING_LEVELS.map((level) => ({ name: level, value: level })),
        ],
        set: (level) => {
          draft.reasoning = level;
        },
      },
      local &&
        open("localReasoningTokens") &&
        number("localReasoningTokens", "Reasoning budget", {
          unit: "tokens",
          help: "Maximum reasoning tokens. Use -1 for unrestricted.",
        }),
      open("turnTimeoutSec") &&
        number("turnTimeoutSec", "Turn inactivity timeout", {
          unit: "seconds",
          help: "Stops a Turn only after this long without model activity.",
        }),
      open("maxTokens") &&
        number("maxTokens", "Max reply tokens", {
          unit: "tokens",
          help: "The most a local or llama.cpp Game Master writes in one call, thinking included.",
        }),
      open("hygieneN") &&
        number("hygieneN", "Light hygiene every", {
          unit: "turns",
          help: "Also retains this many recent Turns after compaction.",
        }),
      open("compactCeilingTokens") &&
        number("compactCeilingTokens", "Context ceiling", { unit: "tokens" }),
      open("compactSeedPercent") &&
        number("compactSeedPercent", "Rebuild seed ceiling", {
          unit: "% of ceiling",
          help: "How full a rebuilt session may start: voice, Scenario, pinned memory and retained Turns together. Pinned memory is never trimmed, so a low percent shortens the retained Turns first and drops them entirely once the pins alone fill it.",
        }),
      open("playTranscriptTailRows") &&
        number("playTranscriptTailRows", "Transcript tail", { unit: "rows" }),
      open("searchFullModel") &&
        text("searchFullModel", "Search model", { blank: "Use Game Master model" }),
      open("searchFullReasoning") &&
        text("searchFullReasoning", "Search reasoning", { blank: "Provider default" }),
      open("gmVoicePath") &&
        text("gmVoicePath", "Game Master voice file", { placeholder: "/path/to/voice.md" }),
      open("debug") && {
        kind: "switch",
        key: "debug",
        label: "Debug logging",
        on: draft.debug,
        set: (on) => {
          draft.debug = on;
        },
      },
      open("logPath") && text("logPath", "Log file", { blank: "No log file" }),
      open("servePort") &&
        number("servePort", "Web port", { help: "Applies after restart." }),
      { kind: "action", key: "save", label: "Save settings", run: save },
      { kind: "action", key: "cancel", label: "Cancel", run: () => ctx.pop() },
    ];
    return all.filter((field): field is Field => field !== false);
  };

  const save = async () => {
    const value: Record<string, unknown> = { ...draft };
    for (const [key, text] of Object.entries(typed)) {
      // not a number: NaN, which the surface refuses in its own words
      value[key] = partialNumber(text) ?? Number.NaN;
    }
    try {
      await ctx.surface.updateSettings(value);
    } catch (error) {
      ctx.notice(playerMessage(error, "Could not save settings."));
      return;
    }
    ctx.toHub();
  };

  ctx.push(
    new FormScreen(ctx, {
      heading: "Settings",
      status: () => "Changes apply to the next adventure you open.",
      fields,
    }),
  );
}
