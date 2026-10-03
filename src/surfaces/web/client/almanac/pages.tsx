import { useState } from "preact/hooks";
import {
  GENERAL_ENTRY_ID,
  entryChain,
  findEntry,
  knownArchitectures,
  recognizeModel,
  type AlmanacEntry,
} from "@nq/local-inference/almanac.ts";
import type { LocalTuningField } from "@nq/local-inference/tuning.ts";
import { Fleuron, QuillIcon } from "../ornament.tsx";
import {
  type AlmanacModel,
  type EntryDraft,
  SAMPLER_FIELDS,
  catches,
  entryFromDraft,
  entryOwnValues,
  familyOptions,
  formatKnob,
  summarizeTuning,
  whenClause,
} from "../../../../home/almanac_pages.ts";
import type { AlmanacApi } from "./data.ts";
import { FamilySelect } from "./entry_form.tsx";

export function AlmanacIndex(props: {
  entries: AlmanacEntry[];
  models: AlmanacModel[];
  yours: AlmanacEntry[];
  all: AlmanacEntry[];
  query: string;
  onQuery: (query: string) => void;
  onOpen: (id: string) => void;
  onWrite: () => void;
}) {
  const needle = props.query.trim().toLowerCase();
  const visible = (entry: AlmanacEntry) =>
    !needle ||
    entry.title.toLowerCase().includes(needle) ||
    (entry.maker ?? "").toLowerCase().includes(needle);
  const caughtBy = new Map<string, number>();
  for (const model of props.models) {
    if (!model.identity) continue;
    const id = recognizeModel(model.identity, props.all).entry.id;
    caughtBy.set(id, (caughtBy.get(id) ?? 0) + 1);
  }
  const { makers, book } = familyOptions(props.entries);
  const general = props.entries.find((entry) => entry.id === GENERAL_ENTRY_ID);

  const row = (entry: AlmanacEntry, index: number) => {
    const parent = entry.extends ? findEntry(entry.extends, props.all) : undefined;
    const own = entryOwnValues(entry);
    const summary = Object.keys(own).length > 0 ? summarizeTuning(own, 3) : "";
    const count = caughtBy.get(entry.id) ?? 0;
    return (
      <li key={entry.id} style={{ "--i": String(index) }}>
        <button
          type="button"
          class="almanac-row"
          onClick={() => props.onOpen(entry.id)}
        >
          <span class="almanac-row-title">
            {entry.source === "yours" ? <QuillIcon class="almanac-row-quill" /> : null}
            {entry.title}
          </span>
          <span class="toc-leader" aria-hidden="true" />
          <span class="almanac-row-values">
            {summary || (parent ? `built on ${parent.title}` : "")}
          </span>
          {count > 0 ? (
            <span
              class="almanac-row-caught"
              title={`Auto uses this for ${count} of your models`}
            >
              {count === 1 ? "1 of yours" : `${count} of yours`}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  const yoursShown = props.yours.filter(visible);
  let index = 0;
  return (
    <>
      <div class="almanac-tools">
        <label class="almanac-search">
          <span>Find an entry</span>
          <input
            type="search"
            value={props.query}
            placeholder="Gemma, Qwen 3.8, Mistral…"
            onInput={(event) => props.onQuery(event.currentTarget.value)}
          />
        </label>
        <button type="button" class="almanac-write" onClick={props.onWrite}>
          <QuillIcon class="receipt-action-icon" />
          Write a new entry
        </button>
      </div>

      <section class="almanac-section">
        <h3>In your hand</h3>
        {props.yours.length === 0 ? (
          <p class="almanac-empty">
            Nothing written here yet. Your answers to “Not right?”, and values
            you write down from the load page, are kept here.
          </p>
        ) : yoursShown.length === 0 ? (
          <p class="almanac-empty">None of yours match.</p>
        ) : (
          <ul class="almanac-list">{yoursShown.map((entry) => row(entry, index++))}</ul>
        )}
      </section>

      <section class="almanac-section">
        <h3>By the book</h3>
        {makers.map((maker) => {
          const list = book.filter(
            (entry) => (entry.maker ?? "Other") === maker && visible(entry),
          );
          if (list.length === 0) return null;
          return (
            <div key={maker} class="almanac-maker">
              <h4>{maker}</h4>
              <ul class="almanac-list">{list.map((entry) => row(entry, index++))}</ul>
            </div>
          );
        })}
        {general && visible(general) ? (
          <div class="almanac-maker">
            <h4>For everything else</h4>
            <ul class="almanac-list">{row(general, index++)}</ul>
          </div>
        ) : null}
      </section>
      <p class="almanac-credit">
        The book's values are transcribed from a community settings guide
        (overhead520's LLM Settings Guide on Hugging Face).
      </p>
    </>
  );
}

function ValuesTable(props: { entry: AlmanacEntry }) {
  const { entry } = props;
  const columns = (
    [
      ["values", "Always"],
      ["thinking", "While thinking"],
      ["plain", "Without thinking"],
    ] as const
  ).filter(([key]) => entry[key] && Object.keys(entry[key]!).length > 0);
  const rows = SAMPLER_FIELDS.filter((field) =>
    columns.some(([key]) => entry[key]?.[field.key] !== undefined),
  );
  if (rows.length === 0) return null;
  return (
    <table class="almanac-values">
      <thead>
        <tr>
          <th scope="col">
            <span class="sr-only">Setting</span>
          </th>
          {columns.map(([key, label]) => (
            <th key={key} scope="col">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((field) => (
          <tr key={field.key}>
            <th scope="row">{field.label}</th>
            {columns.map(([key]) => {
              const value = entry[key]?.[field.key];
              return (
                <td key={key}>{value === undefined ? "—" : formatKnob(field, value)}</td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AlmanacEntryPage(props: {
  entry: AlmanacEntry | undefined;
  models: AlmanacModel[];
  almanac: AlmanacApi;
  onBack: () => void;
  onOpen: (id: string) => void;
  onEdit: (entry: AlmanacEntry, copy: boolean) => void;
}) {
  const [tearing, setTearing] = useState(false);
  const { entry } = props;
  if (!entry) {
    return (
      <div class="almanac-page">
        <button type="button" class="almanac-back" onClick={props.onBack}>
          ‹ All entries
        </button>
        <p class="almanac-empty">That entry is no longer in the Almanac.</p>
      </div>
    );
  }
  const all = props.almanac.all;
  const chain = entryChain(entry, all).slice(1);
  const caught = catches(entry, props.models, all);
  const mine = entry.source === "yours";
  return (
    <article class="almanac-page" aria-labelledby="almanac-entry-title">
      <button type="button" class="almanac-back" onClick={props.onBack}>
        ‹ All entries
      </button>
      <header class="almanac-page-head">
        <p class="almanac-page-kicker">
          {mine ? (
            <>
              <QuillIcon class="almanac-row-quill" /> In your hand
            </>
          ) : (
            (entry.maker ?? "By the book")
          )}
        </p>
        <h3 id="almanac-entry-title">{entry.title}</h3>
        <Fleuron class="almanac-fleuron" />
      </header>
      <p class="almanac-when">{whenClause(entry)}</p>
      {chain.length > 0 ? (
        <p class="almanac-built-on">
          Built on{" "}
          {chain.map((link, index) => (
            <span key={link.id}>
              {index > 0 ? ", then " : ""}
              <button type="button" class="almanac-link" onClick={() => props.onOpen(link.id)}>
                {link.title}
              </button>
            </span>
          ))}
          : anything this page leaves blank comes from there.
        </p>
      ) : null}
      <ValuesTable entry={entry} />
      {entry.notes?.length ? (
        <ul class="temperament-notes almanac-notes">
          {entry.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      <section class="almanac-catches">
        <h4>Catches your models</h4>
        {caught.length === 0 ? (
          <p class="almanac-empty">None of your installed models.</p>
        ) : (
          <ul>
            {caught.map((item) => (
              <li key={item.model.selector ?? item.model.name} class={item.caught ? "is-caught" : "is-lost"}>
                <span aria-hidden="true">{item.caught ? "✓" : "✗"}</span>
                <span class="almanac-catch-name">{item.model.name}</span>
                {!item.caught ? (
                  <small>
                    {item.winner.title} comes first
                  </small>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {props.almanac.error ? (
        <p class="almanac-error" role="alert">
          {props.almanac.error}
        </p>
      ) : null}
      <div class="almanac-page-actions">
        {mine ? (
          tearing ? (
            <>
              <span class="almanac-confirm">Tear this page out of the Almanac?</span>
              <button type="button" class="receipt-action quiet" onClick={() => setTearing(false)}>
                Keep it
              </button>
              <button
                type="button"
                class="almanac-danger"
                onClick={async () => {
                  if (await props.almanac.remove(entry.id)) props.onBack();
                }}
              >
                Tear it out
              </button>
            </>
          ) : (
            <>
              <button type="button" class="receipt-action quiet" onClick={() => setTearing(true)}>
                Tear out…
              </button>
              <button type="button" class="almanac-primary" onClick={() => props.onEdit(entry, false)}>
                Edit this entry
              </button>
            </>
          )
        ) : (
          <button type="button" class="almanac-primary" onClick={() => props.onEdit(entry, true)}>
            <QuillIcon class="receipt-action-icon" />
            Copy into your hand
          </button>
        )}
      </div>
    </article>
  );
}

export function AlmanacEditor(props: {
  draft: EntryDraft;
  editing?: string;
  models: AlmanacModel[];
  almanac: AlmanacApi;
  onDraft: (draft: EntryDraft) => void;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const { draft } = props;
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<EntryDraft>) => props.onDraft({ ...draft, ...patch });
  const preview = entryFromDraft(draft, props.editing ?? "draft-preview");
  const others = props.almanac.all.filter((entry) => entry.id !== props.editing);
  const caught = catches(preview, props.models, [preview, ...others]);
  const architectures = [
    ...new Set([
      ...knownArchitectures(),
      ...props.models.flatMap((model) =>
        model.identity?.architecture ? [model.identity.architecture] : [],
      ),
    ]),
  ].sort();
  const cell = (column: "values" | "thinking" | "plain", field: LocalTuningField) => (
    <td key={column}>
      <input
        type="number"
        inputMode="decimal"
        aria-label={`${field.label}, ${column === "values" ? "always" : column === "thinking" ? "while thinking" : "without thinking"}`}
        min={field.min}
        max={field.max}
        step={field.integer ? 1 : "any"}
        value={draft[column][field.key] ?? ""}
        onInput={(event) =>
          set({ [column]: { ...draft[column], [field.key]: event.currentTarget.value } })
        }
      />
    </td>
  );

  return (
    <form
      class="almanac-page almanac-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        const { source: _source, id: _id, ...entry } = preview;
        const saved = await props.almanac.save({
          ...entry,
          ...(props.editing ? { id: props.editing } : {}),
        });
        setSaving(false);
        if (saved) props.onSaved(saved.id);
      }}
    >
      <button type="button" class="almanac-back" onClick={props.onCancel}>
        ‹ {props.editing ? "Back to the entry" : "All entries"}
      </button>
      <header class="almanac-page-head">
        <p class="almanac-page-kicker">
          <QuillIcon class="almanac-row-quill" /> {props.editing ? "Editing your entry" : "A new entry"}
        </p>
      </header>
      <div class="almanac-fields">
        <label class="wide">
          Title
          <input
            value={draft.title}
            required
            placeholder="Lucent Witch, Bonsai at 0.6…"
            onInput={(event) => set({ title: event.currentTarget.value })}
          />
        </label>
        <label class="wide">
          Names like
          <input
            value={draft.names}
            spellcheck={false}
            placeholder="*lucent-witch*, *witch-31b*"
            onInput={(event) => set({ names: event.currentTarget.value })}
          />
          <small>
            Separate patterns with commas. <code>*</code> stands for anything;
            case, spaces, <code>_</code> and <code>-</code> don't matter. The
            file name, the model's own name and its base models are all tried.
          </small>
        </label>
        <label>
          Architecture
          <select
            value={draft.architecture}
            onChange={(event) => set({ architecture: event.currentTarget.value })}
          >
            <option value="">Any</option>
            {architectures.map((arch) => (
              <option key={arch} value={arch}>
                {arch}
              </option>
            ))}
          </select>
        </label>
        <label>
          Built on
          <FamilySelect
            entries={props.almanac.data?.entries ?? []}
            value={draft.extends}
            empty="Nothing (blank values follow the model)"
            exclude={props.editing}
            onChange={(id) => set({ extends: id })}
          />
        </label>
      </div>
      <table class="almanac-values is-editing">
        <thead>
          <tr>
            <th scope="col">
              <span class="sr-only">Setting</span>
            </th>
            <th scope="col">Always</th>
            <th scope="col">While thinking</th>
            <th scope="col">Without thinking</th>
          </tr>
        </thead>
        <tbody>
          {SAMPLER_FIELDS.map((field) => (
            <tr key={field.key}>
              <th scope="row" title={field.help}>
                {field.label}
              </th>
              {cell("values", field)}
              {cell("thinking", field)}
              {cell("plain", field)}
            </tr>
          ))}
        </tbody>
      </table>
      <p class="almanac-hint">Leave a value blank to take it from what the entry is built on.</p>
      <label class="almanac-notes-field">
        Notes
        <textarea
          value={draft.notes}
          placeholder="One per line. Shown on the load page when this entry is used."
          onInput={(event) => set({ notes: event.currentTarget.value })}
        />
      </label>
      <section class="almanac-catches">
        <h4>Would catch</h4>
        {caught.length === 0 ? (
          <p class="almanac-empty">None of your installed models yet.</p>
        ) : (
          <ul>
            {caught.map((item) => (
              <li key={item.model.selector ?? item.model.name} class={item.caught ? "is-caught" : "is-lost"}>
                <span aria-hidden="true">{item.caught ? "✓" : "✗"}</span>
                <span class="almanac-catch-name">{item.model.name}</span>
                {!item.caught ? <small>{item.winner.title} comes first</small> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {props.almanac.error ? (
        <p class="almanac-error" role="alert">
          {props.almanac.error}
        </p>
      ) : null}
      <div class="almanac-page-actions">
        <button type="button" class="receipt-action quiet" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" class="almanac-primary" disabled={saving || !draft.title.trim()}>
          {saving ? "Writing…" : "Write it down"}
        </button>
      </div>
    </form>
  );
}
