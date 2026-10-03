import { useState } from "preact/hooks";
import type { HomeSettings } from "../../../../home/settings.ts";
import { partialNumber, REASONING_LEVELS } from "../../../../home/fields.ts";

type SettingsPanelProps = {
  settings: HomeSettings;
  /** Keys this surface fixes; their fields are not shown. */
  fixed: string[];
  onClose: () => void;
  onSave: (settings: HomeSettings) => Promise<boolean>;
};

export function SettingsPanel(props: SettingsPanelProps) {
  const open = (key: keyof HomeSettings) => !props.fixed.includes(key);
  const [draft, setDraft] = useState<HomeSettings>(() => ({
    ...props.settings,
  }));
  const [saving, setSaving] = useState(false);
  const update = <K extends keyof HomeSettings>(
    key: K,
    value: HomeSettings[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const number = (key: keyof HomeSettings, event: Event) => {
    const parsed = partialNumber(
      (event.currentTarget as HTMLInputElement).value,
    );
    if (parsed !== undefined) update(key, parsed);
  };
  const isLocalModel = draft.model.trim().startsWith("llama.cpp/");

  return (
    <div class="home-settings-backdrop">
      <section
        class="home-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="home-settings-title"
      >
        <div class="home-settings-head">
          <div>
            <h2 id="home-settings-title">Settings</h2>
            <p>Changes apply to the next adventure you open.</p>
          </div>
          <button
            type="button"
            class="home-settings-close"
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSaving(true);
            void props.onSave(draft).finally(() => setSaving(false));
          }}
        >
          <fieldset>
            <legend>Game master</legend>
            {open("model") ? (
              <label class="wide">
                Model
                <input
                  data-modal-first
                  autoFocus
                  value={draft.model}
                  placeholder="provider/model"
                  onInput={(event) => update("model", event.currentTarget.value)}
                />
                <small>Use Accounts on Home when a model needs sign-in.</small>
              </label>
            ) : null}
            <label class="wide">
              GM personality
              <textarea
                rows={3}
                // first in the dialog when the model is fixed
                data-modal-first={open("model") ? undefined : true}
                value={draft.gmPersonality}
                placeholder="Dry, observant, and fond of difficult bargains."
                onInput={(event) =>
                  update("gmPersonality", event.currentTarget.value)
                }
              />
              <small>
                Additional character and temperament for the Game Master.
              </small>
            </label>
            {isLocalModel ? (
              <label class="wide">
                Local thinking opener
                <textarea
                  rows={3}
                  value={draft.localThinkingOpener}
                  placeholder="First, examine the relationships among the characters here and check whether enough is known about each of them."
                  onInput={(event) =>
                    update("localThinkingOpener", event.currentTarget.value)
                  }
                />
                <small>
                  Starts the first reasoning block of each turn when the local
                  model supports reasoning continuation. Blank uses the built-in
                  numbered step-by-step opener.
                </small>
              </label>
            ) : null}
            <label>
              Reasoning
              <select
                value={draft.reasoning}
                onChange={(event) =>
                  update("reasoning", event.currentTarget.value)
                }
              >
                {!REASONING_LEVELS.includes(
                  draft.reasoning as (typeof REASONING_LEVELS)[number],
                ) ? (
                  <option value={draft.reasoning}>{draft.reasoning}</option>
                ) : null}
                {REASONING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            {isLocalModel ? (
              <label>
                Reasoning budget
                <span class="home-settings-unit">
                  <input
                    type="number"
                    min="-1"
                    max="10000000"
                    step="1"
                    value={draft.localReasoningTokens}
                    onInput={(event) => number("localReasoningTokens", event)}
                  />
                  <span>tokens</span>
                </span>
                <small>
                  Maximum reasoning tokens. Use -1 for unrestricted.
                </small>
              </label>
            ) : null}
            <label>
              Turn inactivity timeout
              <span class="home-settings-unit">
                <input
                  type="number"
                  min="1"
                  max="86400"
                  step="1"
                  value={draft.turnTimeoutSec}
                  onInput={(event) => number("turnTimeoutSec", event)}
                />
                <span>seconds</span>
              </span>
              <small>
                Stops a Turn only after this long without model activity.
              </small>
            </label>
            {open("maxTokens") ? (
              <label>
                Max reply tokens
                <span class="home-settings-unit">
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
                  thinking included. A model that never stops fails fast.
                </small>
              </label>
            ) : null}
          </fieldset>

          <fieldset>
            <legend>Memory</legend>
            <label>
              Light hygiene every
              <span class="home-settings-unit">
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={draft.hygieneN}
                  onInput={(event) => number("hygieneN", event)}
                />
                <span>turns</span>
              </span>
              <small>
                Also retains this many recent Turns after compaction.
              </small>
            </label>
            {open("compactCeilingTokens") ? (
              <label>
                Context ceiling
                <span class="home-settings-unit">
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
              <label>
                Rebuild seed ceiling
                <span class="home-settings-unit">
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={draft.compactSeedPercent}
                    onInput={(event) => number("compactSeedPercent", event)}
                  />
                  <span>% of ceiling</span>
                </span>
                <small>
                  How full a rebuilt session may start: voice, Scenario, pinned
                  memory and retained Turns together. Pinned memory is never
                  trimmed, so a low percent shortens the retained Turns first and
                  drops them entirely once the pins alone fill it.
                </small>
              </label>
            ) : null}
            <label>
              Transcript tail
              <span class="home-settings-unit">
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
          </fieldset>

          <details>
            <summary>Search and advanced settings</summary>
            <fieldset>
              <legend>Full search</legend>
              <label>
                Search model
                <input
                  value={draft.searchFullModel}
                  placeholder="Use Game Master model"
                  onInput={(event) =>
                    update("searchFullModel", event.currentTarget.value)
                  }
                />
              </label>
              <label>
                Search reasoning
                <input
                  value={draft.searchFullReasoning}
                  placeholder="Provider default"
                  onInput={(event) =>
                    update("searchFullReasoning", event.currentTarget.value)
                  }
                />
              </label>
              <label class="wide">
                Game Master voice file
                <input
                  value={draft.gmVoicePath}
                  placeholder="/path/to/voice.md"
                  onInput={(event) =>
                    update("gmVoicePath", event.currentTarget.value)
                  }
                />
              </label>
            </fieldset>
            <fieldset>
              <legend>Diagnostics and server</legend>
              {open("debug") ? (
                <label class="home-settings-check">
                  <input
                    type="checkbox"
                    checked={draft.debug}
                    onChange={(event) =>
                      update("debug", event.currentTarget.checked)
                    }
                  />
                  Debug logging
                </label>
              ) : null}
              {open("logPath") ? (
                <label>
                  Log file
                  <input
                    value={draft.logPath}
                    placeholder="No log file"
                    onInput={(event) =>
                      update("logPath", event.currentTarget.value)
                    }
                  />
                </label>
              ) : null}
              <label>
                Web port
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={draft.servePort}
                  onInput={(event) => number("servePort", event)}
                />
                <small>Applies after restart.</small>
              </label>
            </fieldset>
          </details>

          <div class="home-settings-actions">
            <button type="button" onClick={props.onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" class="primary" disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
