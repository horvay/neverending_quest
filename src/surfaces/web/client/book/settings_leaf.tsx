import { useEffect, useState } from "preact/hooks";
import {
  applyReadingPrefs,
  loadTypeface,
  readReadingPrefs,
  TEXT_SIZES,
  TYPEFACES,
  writeReadingPrefs,
  type ReadingPrefs,
} from "../reading_prefs.ts";
import type { PlaySettingsView } from "./types.ts";

const PLAY_SETTING_KEYS = [
  "turnTimeoutSec",
  "hygieneN",
  "compactCeilingTokens",
  "compactSeedPercent",
  "playTranscriptTailRows",
  "maxTokens",
  "gmPersonality",
  "debug",
  "logPath",
] as const satisfies ReadonlyArray<keyof PlaySettingsView>;

function playSettingsOf(source: PlaySettingsView): PlaySettingsView {
  const out = {} as Record<string, unknown>;
  for (const key of PLAY_SETTING_KEYS) out[key] = source[key];
  return out as PlaySettingsView;
}

/** A number field reports "" mid-typing (e.g. a lone "-"); keep the old value. */
function typedNumber(raw: string): number | undefined {
  const text = raw.trim();
  if (text === "" || text === "-") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

export function SettingsLeaf(props: {
  settings?: PlaySettingsView;
  fixed?: string[];
  locked: boolean;
  onSave?: (settings: PlaySettingsView) => Promise<string | null>;
}) {
  const open = (key: keyof PlaySettingsView) => !props.fixed?.includes(key);
  const [reading, setReading] = useState<ReadingPrefs>(() => readReadingPrefs());
  const [draft, setDraft] = useState<PlaySettingsView | undefined>(() =>
    props.settings ? playSettingsOf(props.settings) : undefined,
  );
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  useEffect(() => {
    setDraft(props.settings ? playSettingsOf(props.settings) : undefined);
  }, [props.settings]);
  useEffect(() => {
    // load every face once so each choice previews in its own letters
    for (const face of TYPEFACES) loadTypeface(face);
  }, []);

  const chooseReading = (next: ReadingPrefs) => {
    setReading(next);
    writeReadingPrefs(next);
    applyReadingPrefs(next);
  };
  const set = <K extends keyof PlaySettingsView>(
    key: K,
    value: PlaySettingsView[K],
  ) => {
    setStatus(null);
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };
  const number = (key: keyof PlaySettingsView, event: Event) => {
    const value = typedNumber((event.currentTarget as HTMLInputElement).value);
    if (value !== undefined) set(key, value as never);
  };
  const changed = Boolean(
    draft &&
      props.settings &&
      JSON.stringify(draft) !== JSON.stringify(playSettingsOf(props.settings)),
  );

  return (
    <div class="book-settings">
      <section class="settings-group" aria-labelledby="settings-reading">
        <h2 id="settings-reading">Reading</h2>
        <p class="settings-note">Kept by this browser, for every adventure.</p>
        <div class="typefaces" role="radiogroup" aria-label="Typeface">
          {TYPEFACES.map((face) => (
            <label
              key={face.id}
              class={`typeface${reading.typeface === face.id ? " is-on" : ""}`}
            >
              <input
                type="radio"
                name="typeface"
                value={face.id}
                checked={reading.typeface === face.id}
                onChange={() => chooseReading({ ...reading, typeface: face.id })}
              />
              <span class="typeface-sample" style={{ fontFamily: face.stack }} aria-hidden="true">
                Aa
              </span>
              <span class="typeface-text">
                <strong style={{ fontFamily: face.stack }}>{face.name}</strong>
                <small>{face.note}</small>
              </span>
            </label>
          ))}
        </div>
        <div class="text-sizes" role="radiogroup" aria-label="Text size">
          <span class="settings-label" aria-hidden="true">
            Text size
          </span>
          {TEXT_SIZES.map((size) => (
            <label
              key={size.scale}
              class={`text-size${reading.scale === size.scale ? " is-on" : ""}`}
            >
              <input
                type="radio"
                name="text-size"
                checked={reading.scale === size.scale}
                onChange={() => chooseReading({ ...reading, scale: size.scale })}
              />
              <span style={{ fontSize: `${size.scale}em` }}>{size.label}</span>
            </label>
          ))}
        </div>
      </section>

      {draft && props.onSave ? (
        <form
          class="settings-group"
          aria-labelledby="settings-gm"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft || !props.onSave || saving || props.locked) return;
            setSaving(true);
            setStatus(null);
            void props
              .onSave(draft)
              .then((error) =>
                setStatus(
                  error
                    ? { kind: "err", text: error }
                    : { kind: "ok", text: "Saved. The next Turn uses these." },
                ),
              )
              .finally(() => setSaving(false));
          }}
        >
          <h2 id="settings-gm">Game Master</h2>
          <p class="settings-note">
            Saved to your settings and used by this adventure from the next
            Turn.
          </p>
          <label class="settings-field is-wide">
            <span class="settings-label">Personality</span>
            <textarea
              rows={3}
              value={draft.gmPersonality}
              placeholder="Dry, observant, and fond of difficult bargains."
              onInput={(event) =>
                set("gmPersonality", event.currentTarget.value)
              }
            />
            <small>Extra character and temperament for the Game Master.</small>
          </label>
          <label class="settings-field">
            <span class="settings-label">Turn inactivity timeout</span>
            <span class="settings-unit">
              <input
                type="number"
                min="1"
                max="86400"
                value={draft.turnTimeoutSec}
                onInput={(event) => number("turnTimeoutSec", event)}
              />
              <span>seconds</span>
            </span>
            <small>Stops a Turn only after this long without model activity.</small>
          </label>
          {open("maxTokens") ? (
            <label class="settings-field">
              <span class="settings-label">Max reply tokens</span>
              <span class="settings-unit">
                <input
                  type="number"
                  min="256"
                  max="1000000"
                  step="256"
                  value={draft.maxTokens}
                  onInput={(event) => number("maxTokens", event)}
                />
                <span>tokens</span>
              </span>
              <small>
                The most a local or llama.cpp Game Master writes in one call,
                thinking included.
              </small>
            </label>
          ) : null}

          <h2>Memory</h2>
          <div class="settings-grid">
            <label class="settings-field">
              <span class="settings-label">Light hygiene every</span>
              <span class="settings-unit">
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={draft.hygieneN}
                  onInput={(event) => number("hygieneN", event)}
                />
                <span>turns</span>
              </span>
            </label>
            {open("compactCeilingTokens") ? (
              <label class="settings-field">
                <span class="settings-label">Context ceiling</span>
                <span class="settings-unit">
                  <input
                    type="number"
                    min="4096"
                    max="10000000"
                    value={draft.compactCeilingTokens}
                    onInput={(event) => number("compactCeilingTokens", event)}
                  />
                  <span>tokens</span>
                </span>
              </label>
            ) : null}
            {open("compactSeedPercent") ? (
              <label class="settings-field">
                <span class="settings-label">Rebuild seed ceiling</span>
                <span class="settings-unit">
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={draft.compactSeedPercent}
                    onInput={(event) => number("compactSeedPercent", event)}
                  />
                  <span>% of ceiling</span>
                </span>
              </label>
            ) : null}
            <label class="settings-field">
              <span class="settings-label">Transcript tail</span>
              <span class="settings-unit">
                <input
                  type="number"
                  min="0"
                  max="100000"
                  value={draft.playTranscriptTailRows}
                  onInput={(event) => number("playTranscriptTailRows", event)}
                />
                <span>rows</span>
              </span>
            </label>
          </div>

          {open("debug") || open("logPath") ? <h2>Diagnostics</h2> : null}
          {open("debug") ? (
            <label class="settings-check">
              <input
                type="checkbox"
                checked={draft.debug}
                onChange={(event) => set("debug", event.currentTarget.checked)}
              />
              Debug logging
            </label>
          ) : null}
          {open("logPath") ? (
            <label class="settings-field is-wide">
              <span class="settings-label">Log file</span>
              <input
                value={draft.logPath}
                placeholder="No log file"
                onInput={(event) => set("logPath", event.currentTarget.value)}
              />
            </label>
          ) : null}

          <p class="settings-actions">
            <button
              type="submit"
              disabled={!changed || saving || props.locked}
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
            {status ? (
              <span
                class={`settings-status is-${status.kind}`}
                role={status.kind === "err" ? "alert" : "status"}
              >
                {status.text}
              </span>
            ) : props.locked && changed ? (
              <span class="settings-status">
                Save once the Game Master is done.
              </span>
            ) : null}
          </p>
        </form>
      ) : null}

      <p class="settings-footnote">
        The model, provider, and local engine are chosen on Home: changing them
        needs a fresh start.
      </p>
    </div>
  );
}
