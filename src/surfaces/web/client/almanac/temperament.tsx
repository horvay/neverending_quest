import { useEffect, useState } from "preact/hooks";
import {
  resolveAutoTuning,
  type ModelIdentity,
  type ResolvedKnob,
} from "@nq/local-inference/almanac.ts";
import type {
  LocalTuning,
  LocalTuningField,
  LocalTuningKey,
} from "@nq/local-inference/tuning.ts";
import { QuillIcon } from "../ornament.tsx";
import {
  type AlmanacModel,
  SAMPLER_FIELDS,
  formatKnob,
  recognitionHeadline,
  recognitionReason,
  sourceLabel,
  summarizeTuning,
} from "../../../../home/almanac_pages.ts";
import type { AlmanacApi } from "./data.ts";
import { BuiltOnQuestion, WriteEntryForm } from "./entry_form.tsx";

type TemperamentProps = {
  model: AlmanacModel | undefined;
  reasoning: string;
  almanac: AlmanacApi;
  /** The player's own value text per knob, for this model. */
  drafts: Record<string, string>;
  onDraft: (key: LocalTuningKey, text: string) => void;
  onClearDrafts: () => void;
  onOpenAlmanac: (entryId?: string) => void;
};

/** Auto's pick for the model being loaded, and every value it will use. */
export function TemperamentCard(props: TemperamentProps) {
  const identity: ModelIdentity = props.model?.identity ?? {
    file: props.model?.name ?? "this model",
    alias: props.model?.name ?? "local",
    baseModels: [],
  };
  const all = props.almanac.all;
  // what Auto alone would pick: shown under the player's own values
  const auto = resolveAutoTuning({
    identity,
    yours: all,
    reasoning: props.reasoning,
    modelFile: props.model?.sampling,
  });
  const unsure = auto.recognition.confidence !== "named";
  const [asking, setAsking] = useState(unsure);
  const [writing, setWriting] = useState(false);
  const overridden = SAMPLER_FIELDS.filter(
    (field) => (props.drafts[field.key] ?? "").trim() !== "",
  );
  const [numbersOpen, setNumbersOpen] = useState(overridden.length > 0);
  // a different model, or a new answer, is a different question
  useEffect(() => {
    setAsking(unsure);
    setWriting(false);
  }, [props.model?.selector, unsure]);
  useEffect(() => {
    if (overridden.length > 0) setNumbersOpen(true);
  }, [overridden.length > 0]);

  const headline = recognitionHeadline(auto);
  const preview: LocalTuning = {};
  for (const field of SAMPLER_FIELDS.slice(0, 4)) {
    const text = props.drafts[field.key]?.trim();
    preview[field.key] = text ? Number(text) : auto.knobs[field.key].value;
  }

  return (
    <section class="temperament" aria-labelledby="temperament-title">
      <header class="temperament-head">
        <p class="temperament-kicker" id="temperament-title">
          Temperament
        </p>
        <div class="temperament-line">
          <p class="temperament-pick" data-confidence={auto.recognition.confidence}>
            <span class="temperament-lead">{headline.lead}</span>
            {auto.recognition.entry.source === "yours" ? (
              <QuillIcon class="temperament-quill" />
            ) : null}
            <button
              type="button"
              class="temperament-title"
              title="Open this entry in the Almanac"
              onClick={() => props.onOpenAlmanac(auto.recognition.entry.id)}
            >
              {headline.title}
            </button>
            <span class="temperament-mode">
              {auto.mode === "thinking" ? "thinking" : "without thinking"}
            </span>
          </p>
          {!asking ? (
            <button
              type="button"
              class="temperament-ask"
              onClick={() => setAsking(true)}
            >
              Not right?
            </button>
          ) : null}
        </div>
        <p class="temperament-reason">
          {recognitionReason(auto, identity, all)}
        </p>
        {auto.notes.length > 0 ? (
          <ul class="temperament-notes">
            {auto.notes.map((note) => (
              <li key={`${note.entryId}:${note.text}`}>{note.text}</li>
            ))}
          </ul>
        ) : null}
      </header>

      {asking ? (
        <BuiltOnQuestion
          identity={identity}
          auto={auto}
          almanac={props.almanac}
          onDone={() => setAsking(false)}
        />
      ) : null}

      <details
        class="temperament-numbers"
        open={numbersOpen}
        onToggle={(event) =>
          setNumbersOpen((event.currentTarget as HTMLDetailsElement).open)
        }
      >
        <summary>
          <span class="temperament-numbers-label">The numbers</span>
          <span class="temperament-preview">{summarizeTuning(preview, 4)}</span>
          {overridden.length > 0 ? (
            <span class="temperament-yours-count">
              {overridden.length} of yours
            </span>
          ) : null}
        </summary>
        <div class="receipt" role="group" aria-label="Sampling">
          {SAMPLER_FIELDS.map((field) => (
            <ReceiptRow
              key={field.key}
              field={field}
              knob={auto.knobs[field.key]}
              text={props.drafts[field.key] ?? ""}
              onText={(text) => props.onDraft(field.key, text)}
            />
          ))}
        </div>
        <div class="receipt-foot">
          {overridden.length > 0 ? (
            <>
              <button
                type="button"
                class="receipt-action"
                onClick={() => setWriting(true)}
                disabled={writing}
              >
                <QuillIcon class="receipt-action-icon" />
                Write these into the Almanac…
              </button>
              <button
                type="button"
                class="receipt-action quiet"
                onClick={props.onClearDrafts}
              >
                Return every value to Auto
              </button>
            </>
          ) : (
            <p class="receipt-hint">
              Type over any value to use your own. Blank follows Auto.
            </p>
          )}
        </div>
        {writing ? (
          <WriteEntryForm
            identity={identity}
            auto={auto}
            almanac={props.almanac}
            drafts={props.drafts}
            onCancel={() => setWriting(false)}
            onWritten={() => {
              setWriting(false);
              props.onClearDrafts();
            }}
          />
        ) : null}
      </details>
      <button
        type="button"
        class="temperament-almanac-link"
        onClick={() => props.onOpenAlmanac()}
      >
        Open the Almanac ›
      </button>
    </section>
  );
}

function ReceiptRow(props: {
  field: LocalTuningField;
  knob: ResolvedKnob;
  text: string;
  onText: (text: string) => void;
}) {
  const { field, knob } = props;
  const id = `receipt-${field.key}`;
  const mine = props.text.trim() !== "";
  const source = sourceLabel(knob);
  return (
    <div class={`receipt-row${mine ? " is-yours" : ""}`} title={field.help}>
      <label class="receipt-name" for={id}>
        {field.label}
      </label>
      <span class="receipt-leader" aria-hidden="true" />
      {mine ? (
        <s class="receipt-auto" aria-label={`Auto: ${formatKnob(field, knob.value)}`}>
          {formatKnob(field, knob.value)}
        </s>
      ) : (
        // holds the column, so every row's value and source line up
        <span class="receipt-auto" aria-hidden="true" />
      )}
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={field.min}
        max={field.max}
        step={field.integer ? 1 : "any"}
        value={props.text}
        placeholder={formatKnob(field, knob.value)}
        onInput={(event) => props.onText(event.currentTarget.value)}
      />
      <span
        class={`receipt-source is-${mine ? "yours" : knob.source.kind}`}
      >
        {mine ? (
          <>
            <QuillIcon class="receipt-quill" />
            yours
          </>
        ) : knob.source.kind === "entry" && knob.source.yours ? (
          <>
            <QuillIcon class="receipt-quill" />
            {source}
          </>
        ) : (
          source
        )}
      </span>
      {mine ? (
        <button
          type="button"
          class="receipt-reset"
          aria-label={`Return ${field.label} to Auto`}
          title="Return to Auto"
          onClick={() => props.onText("")}
        >
          ↺
        </button>
      ) : (
        <span class="receipt-reset-space" aria-hidden="true" />
      )}
    </div>
  );
}
