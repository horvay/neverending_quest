import { useState } from "preact/hooks";
import {
  GENERAL_ENTRY_ID,
  findEntry,
  suggestNamePattern,
  type AlmanacEntry,
  type AlmanacMode,
  type AutoTuning,
  type ModelIdentity,
} from "@nq/local-inference/almanac.ts";
import type { LocalTuning } from "@nq/local-inference/tuning.ts";
import { QuillIcon } from "../ornament.tsx";
import type { AlmanacApi } from "./data.ts";
import {
  SAMPLER_FIELDS,
  familyOptions,
  modelTitle,
  summarizeTuning,
} from "../../../../home/almanac_pages.ts";

export function FamilySelect(props: {
  entries: AlmanacEntry[];
  value: string;
  onChange: (id: string) => void;
  id?: string;
  empty?: string;
  exclude?: string;
}) {
  const { yours, makers, book } = familyOptions(props.entries);
  return (
    <select
      id={props.id}
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    >
      {props.empty !== undefined ? <option value="">{props.empty}</option> : null}
      {yours.length > 0 ? (
        <optgroup label="Your entries">
          {yours
            .filter((entry) => entry.id !== props.exclude)
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
        </optgroup>
      ) : null}
      {makers.map((maker) => (
        <optgroup key={maker} label={maker}>
          {book
            .filter((entry) => (entry.maker ?? "Other") === maker)
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
        </optgroup>
      ))}
      <option value={GENERAL_ENTRY_ID}>General settings</option>
    </select>
  );
}

/**
 * The inline panels sit inside the load page's form, where Enter in a field
 * would load the model; a field's own handler decides what Enter does.
 */
function holdEnter(event: KeyboardEvent) {
  if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
    event.preventDefault();
  }
}

/** "Which model is this built on?" — the answer becomes one of the player's entries. */
export function BuiltOnQuestion(props: {
  identity: ModelIdentity;
  auto: AutoTuning;
  almanac: AlmanacApi;
  onDone: () => void;
}) {
  const entries = props.almanac.data?.entries ?? [];
  const recognized = props.auto.recognition.entry;
  // a player's "built on" entry is the question already answered: ask about its parent
  const current =
    recognized.source === "yours" && recognized.extends ? recognized.extends : recognized.id;
  const candidates = [
    ...(recognized.source === "yours" && recognized.extends
      ? [findEntry(recognized.extends, props.almanac.all)]
      : [recognized]),
    ...props.auto.recognition.alternatives.map((hit) => hit.entry),
  ]
    .filter(
      (entry): entry is AlmanacEntry =>
        !!entry && entry.id !== GENERAL_ENTRY_ID && entry.source === "built-in",
    )
    .filter((entry, index, list) => list.findIndex((e) => e.id === entry.id) === index)
    .slice(0, 4);
  // nothing recognised it: "I don't know" until the player picks a family
  const [choice, setChoice] = useState<string>(
    current === GENERAL_ENTRY_ID ? (candidates[0]?.id ?? GENERAL_ENTRY_ID) : current,
  );
  const [other, setOther] = useState<string>(
    candidates.some((entry) => entry.id === current) || current === GENERAL_ENTRY_ID
      ? ""
      : current,
  );
  const existing =
    recognized.source === "yours" && !recognized.values && !recognized.thinking && !recognized.plain
      ? recognized
      : undefined;
  const [pattern, setPattern] = useState(
    existing?.match.names?.[0] ?? suggestNamePattern(props.identity),
  );
  const [saving, setSaving] = useState(false);
  const chosen = choice === "other" ? other : choice;
  const unsure = props.auto.recognition.confidence !== "named";
  const ready = Boolean(pattern.trim() && chosen);
  const remember = async () => {
    if (!ready || saving) return;
    setSaving(true);
    const saved = await props.almanac.save({
      ...(existing ? { id: existing.id } : {}),
      title: modelTitle(props.identity),
      match: { names: [pattern.trim()] },
      extends: chosen,
    });
    setSaving(false);
    if (saved) props.onDone();
  };

  // not a form: it sits inside the load page's form, and its Enter must not load
  return (
    <div
      class="built-on"
      role="group"
      aria-label="What this model is built on"
      onKeyDown={holdEnter}
    >
      <fieldset class="built-on-choices">
        <legend>
          {unsure ? "Auto isn't sure. " : ""}Which model is this built on?
        </legend>
        {candidates.map((entry, index) => (
          <label key={entry.id} class="built-on-choice">
            <input
              type="radio"
              name="built-on"
              value={entry.id}
              checked={choice === entry.id}
              onChange={() => setChoice(entry.id)}
            />
            <span class="built-on-name">{entry.title}</span>
            {entry.id === current && props.auto.recognition.confidence === "named" ? (
              <small>what Auto read</small>
            ) : index === 0 && unsure ? (
              <small>best guess</small>
            ) : entry.match.architecture?.includes(props.identity.architecture ?? "") ? (
              <small>same architecture</small>
            ) : null}
          </label>
        ))}
        <label class="built-on-choice">
          <input
            type="radio"
            name="built-on"
            value="other"
            checked={choice === "other"}
            onChange={() => setChoice("other")}
          />
          <span class="built-on-name">Another family</span>
          <FamilySelect
            entries={entries.filter((entry) => entry.source === "built-in")}
            value={other}
            empty="Choose a family…"
            onChange={(id) => {
              setOther(id);
              setChoice("other");
            }}
          />
        </label>
        <label class="built-on-choice">
          <input
            type="radio"
            name="built-on"
            value={GENERAL_ENTRY_ID}
            checked={choice === GENERAL_ENTRY_ID}
            onChange={() => setChoice(GENERAL_ENTRY_ID)}
          />
          <span class="built-on-name">I don't know</span>
          <small>use the General settings</small>
        </label>
      </fieldset>
      <label class="built-on-pattern">
        For files named like
        <input
          value={pattern}
          spellcheck={false}
          onInput={(event) => setPattern(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void remember();
          }}
        />
        <small>
          Other quants of the same model match too. <code>*</code> stands for anything.
        </small>
      </label>
      {props.almanac.error ? (
        <p class="almanac-error" role="alert">
          {props.almanac.error}
        </p>
      ) : null}
      <div class="built-on-actions">
        <button type="button" class="receipt-action quiet" onClick={props.onDone}>
          Not now
        </button>
        <button
          type="button"
          class="almanac-primary"
          disabled={saving || !ready}
          onClick={() => void remember()}
        >
          {saving ? "Writing…" : "Remember this"}
        </button>
      </div>
    </div>
  );
}

/** Writes the player's own values into the Almanac, so Auto uses them next time. */
export function WriteEntryForm(props: {
  identity: ModelIdentity;
  auto: AutoTuning;
  almanac: AlmanacApi;
  drafts: Record<string, string>;
  onCancel: () => void;
  onWritten: () => void;
}) {
  const recognized = props.auto.recognition.entry;
  const family =
    recognized.source === "built-in" && recognized.id !== GENERAL_ENTRY_ID
      ? recognized
      : undefined;
  const ownEntry = recognized.source === "yours" ? recognized : undefined;
  type Scope = "own" | "file" | "family";
  const [scope, setScope] = useState<Scope>(ownEntry ? "own" : "file");
  const [mode, setMode] = useState<"values" | AlmanacMode>("values");
  const [title, setTitle] = useState(modelTitle(props.identity));
  const [pattern, setPattern] = useState(suggestNamePattern(props.identity));
  const [saving, setSaving] = useState(false);
  const values: LocalTuning = {};
  for (const field of SAMPLER_FIELDS) {
    const text = props.drafts[field.key]?.trim();
    if (text) values[field.key] = Number(text);
  }

  const submit = async () => {
    setSaving(true);
    let entry: Partial<AlmanacEntry>;
    if (scope === "own" && ownEntry) {
      entry = { ...ownEntry, [mode]: { ...ownEntry[mode], ...values } };
    } else if (scope === "family" && family) {
      entry = {
        title: `${family.title} (yours)`,
        match: family.match,
        extends: family.id,
        [mode]: values,
      };
    } else {
      entry = {
        title: title.trim() || modelTitle(props.identity),
        match: { names: [pattern.trim() || suggestNamePattern(props.identity)] },
        // the values not written here keep following what Auto read
        extends: ownEntry?.extends ?? recognized.id,
        [mode]: values,
      };
    }
    const saved = await props.almanac.save(entry);
    setSaving(false);
    if (saved) props.onWritten();
  };
  // these fields sit inside the load page's form: Enter writes, never loads
  const enterWrites = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!saving) void submit();
  };

  return (
    <div
      class="write-entry"
      role="group"
      aria-label="Write into the Almanac"
      onKeyDown={holdEnter}
    >
      <p class="write-entry-lead">
        <QuillIcon class="receipt-action-icon" />
        {summarizeTuning(values, 6)}
      </p>
      <fieldset class="built-on-choices">
        <legend>Use these for</legend>
        {ownEntry ? (
          <label class="built-on-choice">
            <input
              type="radio"
              name="write-scope"
              checked={scope === "own"}
              onChange={() => setScope("own")}
            />
            <span class="built-on-name">Your entry “{ownEntry.title}”</span>
          </label>
        ) : null}
        <label class="built-on-choice">
          <input
            type="radio"
            name="write-scope"
            checked={scope === "file"}
            onChange={() => setScope("file")}
          />
          <span class="built-on-name">Files named like</span>
          <input
            class="write-entry-pattern"
            aria-label="Name pattern"
            value={pattern}
            spellcheck={false}
            onFocus={() => setScope("file")}
            onInput={(event) => setPattern(event.currentTarget.value)}
            onKeyDown={enterWrites}
          />
        </label>
        {family ? (
          <label class="built-on-choice">
            <input
              type="radio"
              name="write-scope"
              checked={scope === "family"}
              onChange={() => setScope("family")}
            />
            <span class="built-on-name">Every {family.title} model</span>
          </label>
        ) : null}
      </fieldset>
      {scope === "file" ? (
        <label class="built-on-pattern">
          Title
          <input
            value={title}
            onInput={(event) => setTitle(event.currentTarget.value)}
            onKeyDown={enterWrites}
          />
        </label>
      ) : null}
      <fieldset class="built-on-choices is-inline">
        <legend>When</legend>
        {(
          [
            ["values", "Always"],
            ["thinking", "Only while thinking"],
            ["plain", "Only without thinking"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} class="built-on-choice">
            <input
              type="radio"
              name="write-mode"
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            <span class="built-on-name">{label}</span>
          </label>
        ))}
      </fieldset>
      {props.almanac.error ? (
        <p class="almanac-error" role="alert">
          {props.almanac.error}
        </p>
      ) : null}
      <div class="built-on-actions">
        <button type="button" class="receipt-action quiet" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="almanac-primary"
          disabled={saving}
          onClick={() => void submit()}
        >
          {saving ? "Writing…" : "Write it down"}
        </button>
      </div>
    </div>
  );
}
