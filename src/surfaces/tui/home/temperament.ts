/**
 * The load page's temperament: which Almanac entry Auto picks for the model
 * being loaded, every sampling value it will use and where each comes from,
 * and the player's own values typed over them.
 */
import {
  resolveAutoTuning,
  type AlmanacEntry,
  type AutoTuning,
  type ModelIdentity,
} from "@nq/local-inference/almanac.ts";
import type { HomeModel, HomeSnapshot } from "../../../home/index.ts";
import {
  SAMPLER_FIELDS,
  formatKnob,
  recognitionHeadline,
  recognitionReason,
  sourceLabel,
  summarizeTuning,
} from "../../../home/almanac_pages.ts";
import { partialNumber } from "../../../home/fields.ts";
import { AlmanacEntryScreen, AlmanacIndexScreen, type AlmanacState } from "./almanac.ts";
import { type Field, FormScreen, NOT_A_NUMBER } from "./form.ts";
import type { HomeCtx, HomeScreen, View } from "./screen.ts";

export type Temperament = {
  identity: ModelIdentity;
  auto: AutoTuning;
  entries: AlmanacEntry[];
  almanac: AlmanacState;
};

/** The page a temperament belongs to. */
export type TemperamentSource = {
  /** Auto's pick; undefined until the Almanac is read. */
  temperament(): Temperament | undefined;
  /** The player's own values for the model, as typed; blank follows Auto. */
  samplingDrafts(): Record<string, string>;
};

/** What Auto picks for `model` at `reasoning`; undefined until the Almanac is read. */
export function readTemperament(
  almanac: AlmanacState,
  model: HomeModel | undefined,
  reasoning: string,
): Temperament | undefined {
  if (!almanac.data) return undefined;
  const identity: ModelIdentity = model?.identity ?? {
    file: model?.name ?? "this model",
    alias: model?.name ?? "local",
    baseModels: [],
  };
  return {
    identity,
    auto: resolveAutoTuning({
      identity,
      yours: almanac.all,
      reasoning,
      ...(model?.sampling ? { modelFile: model.sampling } : {}),
    }),
    entries: almanac.all,
    almanac,
  };
}

/** The load page's temperament row: Auto's pick and a preview of its values. */
export function temperamentField(ctx: HomeCtx, source: TemperamentSource): Field {
  const temperament = source.temperament();
  if (!temperament) {
    return { kind: "note", key: "temperament", label: "Temperament: opening the Almanac…" };
  }
  const { auto } = temperament;
  const drafts = source.samplingDrafts();
  const headline = recognitionHeadline(auto);
  const preview: Record<string, number> = {};
  for (const field of SAMPLER_FIELDS.slice(0, 4)) {
    const text = drafts[field.key]?.trim();
    preview[field.key] = text ? Number(text) : auto.knobs[field.key].value;
  }
  const yours = SAMPLER_FIELDS.filter((field) => (drafts[field.key] ?? "").trim() !== "").length;
  return {
    kind: "action",
    key: "temperament",
    label: `Temperament: ${headline.lead} ${headline.title}`,
    help: `${summarizeTuning(preview, 4)}${yours > 0 ? ` · ${yours} of yours` : ""}`,
    run: () => ctx.push(new TemperamentScreen(ctx, source)),
  };
}

/** Auto's pick for the model being loaded, and every value it will use. */
class TemperamentScreen implements HomeScreen {
  constructor(
    private readonly ctx: HomeCtx,
    private readonly source: TemperamentSource,
  ) {}

  private form(): FormScreen | undefined {
    const temperament = this.source.temperament();
    if (!temperament) return undefined;
    const { auto } = temperament;
    const { ctx } = this;
    const drafts = this.source.samplingDrafts();
    const fields: Field[] = SAMPLER_FIELDS.map((field) => {
      const knob = auto.knobs[field.key];
      const mine = (drafts[field.key] ?? "").trim() !== "";
      return {
        kind: "text",
        key: field.key,
        label: field.label,
        text: drafts[field.key] ?? "",
        blank: formatKnob(field, knob.value),
        placeholder: formatKnob(field, knob.value),
        help: mine ? `yours (Auto: ${formatKnob(field, knob.value)})` : sourceLabel(knob),
        detail: `${field.help}\nAuto: ${formatKnob(field, knob.value)} (${sourceLabel(knob)}). Blank follows Auto.`,
        set: (text: string) => {
          if (text.trim() && partialNumber(text) === undefined) return NOT_A_NUMBER;
          if (text.trim()) drafts[field.key] = text.trim();
          else delete drafts[field.key];
        },
      };
    });
    if (SAMPLER_FIELDS.some((field) => (drafts[field.key] ?? "").trim() !== "")) {
      fields.push({
        kind: "action",
        key: "clear",
        label: "Return every value to Auto",
        run: () => {
          for (const field of SAMPLER_FIELDS) delete drafts[field.key];
        },
      });
    }
    const headline = recognitionHeadline(auto);
    const entry = auto.recognition.entry;
    fields.push(
      {
        kind: "action",
        key: "open-entry",
        label: `Open “${headline.title}” in the Almanac`,
        run: () => ctx.push(new AlmanacEntryScreen(ctx, temperament.almanac, entry.id, false)),
      },
      {
        kind: "action",
        key: "open-almanac",
        label: "Open the Almanac",
        run: () => ctx.push(new AlmanacIndexScreen(ctx, temperament.almanac)),
      },
      { kind: "action", key: "done", label: "Back to This computer", run: () => ctx.pop() },
    );
    return new FormScreen(ctx, {
      heading: "Temperament",
      status: () =>
        [
          `${headline.lead}: ${headline.title} · ${auto.mode === "thinking" ? "thinking" : "without thinking"}`,
          recognitionReason(auto, temperament.identity, temperament.entries),
          ...auto.notes.map((note) => `· ${note.text}`),
          "Type over any value to use your own. Blank follows Auto.",
        ].join("\n"),
      fields: () => fields,
    });
  }

  view(snap: HomeSnapshot): View {
    return (
      this.form()?.view(snap) ?? { heading: "Temperament", status: "Opening the Almanac…", rows: [] }
    );
  }

  choose(value: string): Promise<void> | undefined {
    return this.form()?.choose(value);
  }
}
