/**
 * What the Almanac's pages say, for both Player Surfaces: how a temperament
 * reads, what an entry recognises and catches, and the entry form's draft.
 *
 * Pure: no Node, so the web book bundles it as the terminal Home imports it.
 */
import {
  GENERAL_ENTRY_ID,
  findEntry,
  matchEntry,
  recognizeModel,
  stripQuantTags,
  type AlmanacEntry,
  type AlmanacMode,
  type AutoTuning,
  type ModelIdentity,
  type ResolvedKnob,
} from "@nq/local-inference/almanac.ts";
import {
  LOCAL_TUNING_FIELDS,
  type LocalTuning,
  type LocalTuningField,
  type LocalTuningKey,
} from "@nq/local-inference/tuning.ts";

/** An installed model as the Almanac sees it. */
export type AlmanacModel = {
  selector?: string;
  name: string;
  identity?: ModelIdentity;
  sampling?: LocalTuning;
};

/** The sampling knobs; VRAM headroom is an engine setting, not a temperament. */
export const SAMPLER_FIELDS = LOCAL_TUNING_FIELDS.filter(
  (field) => field.key !== "fitTarget",
);

const SHORT_LABEL: Partial<Record<LocalTuningKey, string>> = {
  temperature: "Temp",
  repeatPenalty: "Repeat",
  repeatLastN: "Repeat window",
  presencePenalty: "Presence",
  frequencyPenalty: "Frequency",
  dryMultiplier: "DRY",
};

function shortLabel(field: LocalTuningField): string {
  return SHORT_LABEL[field.key] ?? field.label;
}

export function formatKnob(field: LocalTuningField, value: number): string {
  if (field.integer) return String(value);
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/** "Temp 1.0 · Top-K 64 · Top-P 0.95" for whichever knobs a record sets. */
export function summarizeTuning(tuning: LocalTuning | undefined, limit = 5): string {
  const parts = SAMPLER_FIELDS.filter((field) => tuning?.[field.key] !== undefined).map(
    (field) => `${shortLabel(field)} ${formatKnob(field, tuning![field.key]!)}`,
  );
  if (parts.length > limit) return `${parts.slice(0, limit).join(" · ")} · …`;
  return parts.join(" · ");
}

export function entryOwnValues(entry: AlmanacEntry, mode?: AlmanacMode): LocalTuning {
  return mode ? { ...entry.values, ...entry[mode] } : { ...entry.values, ...entry.thinking };
}

/** A short title for a model: its header name when it has a real one. */
export function modelTitle(identity: ModelIdentity): string {
  const name =
    identity.name && identity.name.length > 3 && identity.name !== "Hf"
      ? identity.name
      : identity.file;
  return stripQuantTags(name) || name;
}

export function patternLabel(pattern: string): string {
  return pattern.replace(/^\*+|\*+$/g, "").replace(/\*/g, "…");
}

export function sourceLabel(knob: ResolvedKnob): string {
  switch (knob.source.kind) {
    case "yours":
      return "yours";
    case "entry":
      return knob.source.title;
    case "model-file":
      return "model file";
    case "engine":
      return "engine default";
  }
}

/** Auto's pick for a model, as the temperament headline reads it. */
export function recognitionHeadline(auto: AutoTuning): { lead: string; title: string } {
  const { recognition } = auto;
  if (recognition.entry.source === "yours") {
    return { lead: "Your entry", title: recognition.entry.title };
  }
  if (recognition.confidence === "named") {
    return { lead: "By the book", title: recognition.entry.title };
  }
  if (recognition.confidence === "guessed") {
    return { lead: "Probably", title: recognition.entry.title };
  }
  return { lead: "Not in the book", title: "General settings" };
}

/** Why Auto picked what it did. */
export function recognitionReason(
  auto: AutoTuning,
  identity: ModelIdentity,
  entries: AlmanacEntry[],
): string {
  const { recognition } = auto;
  const hit = recognition.hit;
  if (recognition.entry.source === "yours") {
    const parent = recognition.entry.extends
      ? findEntry(recognition.entry.extends, entries)
      : undefined;
    return parent
      ? `You told Auto this is built on ${parent.title}.`
      : "Written in your own hand.";
  }
  if (recognition.confidence === "named" && hit?.pattern) {
    return `Recognised by its ${hit.on}: “${patternLabel(hit.pattern)}”.`;
  }
  if (recognition.confidence === "guessed") {
    return `Its architecture (${identity.architecture}) is shared by several families, so this is a guess.`;
  }
  return `Nothing in the Almanac recognises “${identity.file}”.`;
}

/** Entries grouped by maker, for a picker. */
export function familyOptions(entries: AlmanacEntry[]) {
  const yours = entries.filter((entry) => entry.source === "yours");
  const book = entries.filter(
    (entry) => entry.source === "built-in" && entry.id !== GENERAL_ENTRY_ID,
  );
  const makers = [...new Set(book.map((entry) => entry.maker ?? "Other"))];
  return { yours, makers, book };
}

export type Catch =
  | { model: AlmanacModel; caught: true }
  | { model: AlmanacModel; caught: false; winner: AlmanacEntry };

/** Which installed models an entry catches, and which it loses to another. */
export function catches(
  entry: AlmanacEntry,
  models: AlmanacModel[],
  entries: AlmanacEntry[],
): Catch[] {
  const found: Catch[] = [];
  for (const model of models) {
    if (!model.identity) continue;
    const recognition = recognizeModel(model.identity, entries);
    if (recognition.entry.id === entry.id) {
      found.push({ model, caught: true });
    } else if (matchEntry(entry, model.identity)) {
      found.push({ model, caught: false, winner: recognition.entry });
    }
  }
  return found;
}

/** What an entry recognises, in a sentence. */
export function whenClause(entry: AlmanacEntry): string {
  const names = (entry.match.names ?? []).map((name) => `“${patternLabel(name)}”`);
  const arch = entry.match.architecture ?? [];
  const parts: string[] = [];
  if (names.length > 0) {
    parts.push(
      `names like ${names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0]}`,
    );
  }
  if (arch.length > 0) {
    parts.push(`the ${arch.join(" or ")} architecture`);
  }
  if (parts.length === 0) {
    return entry.id === GENERAL_ENTRY_ID
      ? "Used when no other entry recognises a model."
      : "Only used by entries built on it.";
  }
  return `Recognises models with ${parts.join(", or ")}.`;
}

/** An entry as the write/edit form holds it: every field as typed. */
export type EntryDraft = {
  title: string;
  names: string;
  architecture: string;
  extends: string;
  values: Record<string, string>;
  thinking: Record<string, string>;
  plain: Record<string, string>;
  notes: string;
};

function tuningText(tuning: LocalTuning | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tuning ?? {}).map(([key, value]) => [key, String(value)]),
  );
}

function draftTuning(text: Record<string, string>): LocalTuning | undefined {
  const tuning: LocalTuning = {};
  for (const field of SAMPLER_FIELDS) {
    const raw = text[field.key]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) tuning[field.key] = value;
  }
  return Object.keys(tuning).length > 0 ? tuning : undefined;
}

/** A draft of `entry`, or a copy of it into the player's hand, or a blank one. */
export function draftFrom(entry: AlmanacEntry | undefined, copy = false): EntryDraft {
  return {
    title: entry ? (copy ? `${entry.title} (yours)` : entry.title) : "",
    names: (entry?.match.names ?? []).join(", "),
    architecture: entry?.match.architecture?.[0] ?? "",
    extends: copy ? (entry?.id ?? "") : (entry?.extends ?? ""),
    values: copy ? {} : tuningText(entry?.values),
    thinking: copy ? {} : tuningText(entry?.thinking),
    plain: copy ? {} : tuningText(entry?.plain),
    notes: copy ? "" : (entry?.notes ?? []).join("\n"),
  };
}

export function entryFromDraft(draft: EntryDraft, id?: string): AlmanacEntry {
  const names = draft.names
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const values = draftTuning(draft.values);
  const thinking = draftTuning(draft.thinking);
  const plain = draftTuning(draft.plain);
  const notes = draft.notes
    .split("\n")
    .map((note) => note.trim())
    .filter(Boolean);
  return {
    id: id ?? "draft",
    title: draft.title.trim(),
    source: "yours",
    match: {
      ...(names.length > 0 ? { names } : {}),
      ...(draft.architecture ? { architecture: [draft.architecture] } : {}),
    },
    ...(draft.extends ? { extends: draft.extends } : {}),
    ...(values ? { values } : {}),
    ...(thinking ? { thinking } : {}),
    ...(plain ? { plain } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}
