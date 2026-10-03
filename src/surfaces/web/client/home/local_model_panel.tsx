import { useMemo, useState } from "preact/hooks";
import type { HomeView } from "../../api.ts";
import type { HomeSettings } from "../../../../home/settings.ts";
import type { LocalModelSelection } from "../../../../home/types.ts";
import {
  dropSavedFullProfile,
  LOCAL_TUNING_FIELDS,
  type LocalTuning,
} from "@nq/local-inference/tuning.ts";
import type { ModelIdentity } from "@nq/local-inference/almanac.ts";
import { AlmanacBook } from "../almanac.tsx";
import { useAlmanac } from "../almanac/data.ts";
import { TemperamentCard } from "../almanac/temperament.tsx";
import { readLocalModelPrefs, writeLocalModelPrefs } from "../local_prefs.ts";
import {
  CACHE_TYPES,
  engineName,
  formatModelSize,
  gpuKey,
  prefersPlainAttention,
} from "../../../../home/local_load_page.ts";
import { partialNumber, REASONING_LEVELS } from "../../../../home/fields.ts";

function tuningDrafts(tuning: LocalTuning): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tuning).map(([key, value]) => [key, String(value)]),
  );
}

/** The browser has already held the form to each knob's range and step. */
function parseTuningDrafts(drafts: Record<string, string>): Record<string, number> {
  const tuning: Record<string, number> = {};
  for (const [key, text] of Object.entries(drafts)) {
    const value = partialNumber(text);
    if (value !== undefined) tuning[key] = value;
  }
  return tuning;
}

type LocalModelPanelProps = {
  models: Array<{
    name: string;
    selector?: string;
    size?: number;
    mmproj?: string;
    sampling?: LocalTuning;
    identity?: ModelIdentity;
    engine?: "exl3xpu";
  }>;
  mmproj: Array<{ path: string; name: string; size?: number }>;
  gpus: HomeView["gpus"];
  exl3xpu: HomeView["exl3xpu"];
  localProfiles: HomeView["localProfiles"];
  settings: HomeSettings;
  notice?: string;
  onClose: () => void;
  onSubmit: (selection: LocalModelSelection) => void;
  onDownloadEngine?: (backend: string) => Promise<boolean>;
};

/**
 * The player's own values, as typed, for each model. What is typed, not the
 * number it parses to: "0.0" on the way to "0.05" would otherwise re-render
 * as "0" and eat the decimal point. A blank knob follows Auto.
 */
function initialDrafts(
  remembered: ReturnType<typeof readLocalModelPrefs>,
  settings: HomeSettings,
): Record<string, Record<string, string>> {
  const drafts: Record<string, Record<string, string>> = {};
  const own = (tuning: LocalTuning) => tuningDrafts(dropSavedFullProfile(tuning));
  // the config's values belong to the model it was saved with
  if (settings.model) drafts[settings.model] = own(settings.localTuning);
  // a selection saved before values were kept per model
  if (remembered.model && remembered.tuning && !remembered.tuningByModel) {
    drafts[remembered.model] = own(remembered.tuning);
  }
  for (const [model, tuning] of Object.entries(remembered.tuningByModel ?? {})) {
    drafts[model] = own(tuning);
  }
  return drafts;
}

export function LocalModelPanel(props: LocalModelPanelProps) {
  const configured = props.models.find(
    (model) => model.selector === props.settings.model,
  );
  // the browser remembers the last selection; server settings are the fallback
  const remembered = useMemo(() => readLocalModelPrefs(), []);
  const rememberedModel = props.models.find(
    (model) => model.selector === remembered.model,
  );
  const [model, setModel] = useState(
    rememberedModel?.selector ??
      configured?.selector ??
      props.models[0]?.selector ??
      "",
  );
  // every model keeps its own engine profile: the one saved when it last
  // loaded, or where NQ suggests it runs
  const profileOf = (selector: string) => props.localProfiles?.[selector]?.profile;
  const initial = profileOf(model);
  const [contextTokens, setContextTokens] = useState(
    initial?.contextTokens ?? props.settings.localContextTokens,
  );
  const [reasoningTokens, setReasoningTokens] = useState(
    initial?.reasoningTokens ?? props.settings.localReasoningTokens,
  );
  const [reasoning, setReasoning] = useState(
    remembered.reasoning ?? props.settings.reasoning,
  );
  const [mmproj, setMmproj] = useState(
    (rememberedModel ?? configured)?.mmproj ?? "",
  );
  const [cacheK, setCacheK] = useState(initial?.cacheK ?? props.settings.localCacheK);
  const [cacheV, setCacheV] = useState(initial?.cacheV ?? props.settings.localCacheV);
  const [kvOffload, setKvOffload] = useState(
    initial?.kvOffload ?? props.settings.localKvOffload,
  );
  const gpus = props.gpus?.gpus ?? [];
  // a card that is gone (unplugged, its engine removed) falls back to Automatic
  const listedGpuKey = (wanted: { backend: string; device: string; name: string } | null | undefined) =>
    wanted && gpus.some((candidate) => gpuKey(candidate) === gpuKey(wanted))
      ? gpuKey(wanted)
      : "";
  const [gpu, setGpu] = useState(() =>
    listedGpuKey(initial ? initial.gpu : props.settings.localGpu),
  );
  const chosenGpu = gpus.find((candidate) => gpuKey(candidate) === gpu);
  const [flashAttention, setFlashAttention] = useState(
    initial?.flashAttention ?? props.settings.localFlashAttention,
  );
  const [parallel, setParallel] = useState(initial?.parallel ?? 1);
  const [ramCacheGiB, setRamCacheGiB] = useState(initial?.ramCacheGiB ?? 0);
  const pickGpu = (key: string) => {
    setGpu(key);
    const next = gpus.find((candidate) => gpuKey(candidate) === key);
    // each pick sets the attention that suits the card; the box still wins
    setFlashAttention(!next || !prefersPlainAttention(next));
  };
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [draftsByModel, setDraftsByModel] = useState(() =>
    initialDrafts(remembered, props.settings),
  );
  const drafts = draftsByModel[model] ?? {};
  const setDrafts = (next: Record<string, string>) =>
    setDraftsByModel((current) => ({ ...current, [model]: next }));
  const selected = props.models.find((m) => m.selector === model);
  // EXL3 models run on exl3xpu, which picks the Intel GPU and its own attention
  const onExl3 = selected?.engine === "exl3xpu";
  const exl3Ready = !onExl3 || props.exl3xpu?.installed === true;
  const almanac = useAlmanac();
  // the Almanac opens over the load page, in the same sheet
  const [almanacAt, setAlmanacAt] = useState<string | null | undefined>(
    undefined,
  );
  const pickModel = (selector: string) => {
    setModel(selector);
    // each model keeps its own projector; show that model's, not the last one
    const next = props.models.find((m) => m.selector === selector);
    setMmproj(next?.mmproj ?? "");
    // and its own engine profile
    const profile = profileOf(selector);
    if (!profile) return;
    setContextTokens(profile.contextTokens);
    setReasoningTokens(profile.reasoningTokens);
    setCacheK(profile.cacheK);
    setCacheV(profile.cacheV);
    setKvOffload(profile.kvOffload);
    setFlashAttention(profile.flashAttention);
    setGpu(listedGpuKey(profile.gpu));
    setParallel(profile.parallel);
    setRamCacheGiB(profile.ramCacheGiB);
  };
  const [submitting, setSubmitting] = useState(false);
  const fitTarget = LOCAL_TUNING_FIELDS.find((field) => field.key === "fitTarget")!;

  return (
    <div class="home-settings-backdrop">
      <section
        class={`home-settings home-local${almanacAt !== undefined ? " is-almanac" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={almanacAt !== undefined ? "almanac-title" : "home-local-title"}
      >
        {almanacAt !== undefined ? (
          <AlmanacBook
            almanac={almanac}
            {...(almanacAt ? { startAt: almanacAt } : {})}
            closeLabel="‹ This computer"
            onClose={() => setAlmanacAt(undefined)}
          />
        ) : (
          <>
            <div class="home-settings-head">
              <div>
                <h2 id="home-local-title">This computer</h2>
                <p>Choose the model and how much memory it may use.</p>
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
                if (!model) return;
                setSubmitting(true);
                const tuning = parseTuningDrafts(drafts);
                writeLocalModelPrefs({
                  model,
                  reasoning,
                  tuning,
                  tuningByModel: Object.fromEntries(
                    Object.entries(draftsByModel).map(([key, text]) => [
                      key,
                      parseTuningDrafts(text),
                    ]),
                  ),
                });
                props.onSubmit({
                  model,
                  // only when the picker was shown, so loading a model never
                  // silently clears a projector the UI could not display
                  ...(props.mmproj.length > 0 ? { mmproj } : {}),
                  cacheK,
                  cacheV,
                  kvOffload,
                  flashAttention,
                  ...(onExl3 ? { parallel, ramCacheGiB } : {}),
                  ...(chosenGpu
                    ? {
                        gpu: {
                          backend: chosenGpu.backend,
                          device: chosenGpu.device,
                          name: chosenGpu.name,
                        },
                      }
                    : {}),
                  tuning,
                  contextTokens,
                  reasoningTokens,
                  reasoning,
                });
              }}
            >
              <fieldset disabled={submitting}>
                <legend>Local Game Master</legend>
                <label class="wide">
                  Model
                  <select
                    data-modal-first
                    autoFocus
                    value={model}
                    onChange={(event) => pickModel(event.currentTarget.value)}
                  >
                    {props.models.map((candidate) => (
                      <option
                        key={candidate.selector ?? candidate.name}
                        value={candidate.selector}
                      >
                        {candidate.name}
                        {candidate.size !== undefined
                          ? ` — ${formatModelSize(candidate.size)}`
                          : ""}
                        {candidate.engine === "exl3xpu" ? " · EXL3 on exl3xpu" : ""}
                      </option>
                    ))}
                  </select>
                  <small>
                    {props.localProfiles?.[model]?.saved
                      ? "Loads with the engine settings you last used for this model. "
                      : "New here: NQ suggests where this model runs, and keeps your choices for it. "}
                    NQ unloads the current model before loading a different
                    one.
                  </small>
                </label>
                {onExl3 ? (
                  <div class="wide home-gpu">
                    <p class="home-exl3-note">
                      Runs on the Intel GPU with exl3xpu (vLLM), drafting with
                      the model's assistant when one is installed beside it.
                    </p>
                    {props.exl3xpu?.installed ? null : props.exl3xpu?.downloading ? (
                      <p class="home-exl3-note" role="status">
                        {props.exl3xpu.downloading}
                      </p>
                    ) : (
                      <div class="home-gpu-engine">
                        <button
                          type="button"
                          onClick={() => void props.onDownloadEngine?.("exl3xpu")}
                        >
                          Download the exl3xpu engine
                        </button>
                        <small>
                          About 8 GB once, 18 GB on disk. Needs bubblewrap
                          (bwrap); no Docker.
                        </small>
                      </div>
                    )}
                    {props.exl3xpu?.error ? (
                      <p class="home-gpu-error" role="alert">
                        {props.exl3xpu.error}
                      </p>
                    ) : null}
                  </div>
                ) : gpus.length > 0 || (props.gpus?.downloadable.length ?? 0) > 0 ? (
                  <div class="wide home-gpu">
                    <label>
                      GPU
                      <select
                        value={gpu}
                        onChange={(event) => pickGpu(event.currentTarget.value)}
                      >
                        <option value="">Automatic</option>
                        {gpus.map((candidate) => (
                          <option key={gpuKey(candidate)} value={gpuKey(candidate)}>
                            {candidate.name} — {engineName(candidate.backend)}
                            {candidate.memoryMiB !== undefined
                              ? `, ${formatModelSize(candidate.memoryMiB * 1024 ** 2)}`
                              : ""}
                          </option>
                        ))}
                      </select>
                      <small>
                        Automatic lets the installed engine use every card it
                        can reach.
                      </small>
                    </label>
                    {props.gpus?.downloadable.map((backend) => (
                      <div key={backend} class="home-gpu-engine">
                        <button
                          type="button"
                          disabled={downloading !== null}
                          onClick={async () => {
                            setDownloading(backend);
                            setDownloadFailed(false);
                            const ok =
                              (await props.onDownloadEngine?.(backend)) ?? false;
                            setDownloading(null);
                            setDownloadFailed(!ok);
                          }}
                        >
                          {downloading === backend
                            ? `Downloading the ${engineName(backend)} engine…`
                            : `Find more GPUs with ${engineName(backend)}`}
                        </button>
                        <small>
                          Downloads the {engineName(backend)} engine, which runs
                          on cards from any maker, beside the one you have.
                        </small>
                      </div>
                    ))}
                    {downloadFailed && props.notice ? (
                      <p class="home-gpu-error" role="alert">
                        {props.notice}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <label class="wide">
                  Thinking level
                  <select
                    value={reasoning}
                    onChange={(event) =>
                      setReasoning(event.currentTarget.value)
                    }
                  >
                    {!REASONING_LEVELS.includes(
                      reasoning as (typeof REASONING_LEVELS)[number],
                    ) ? (
                      <option value={reasoning}>{reasoning}</option>
                    ) : null}
                    {REASONING_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                  <small>
                    How much the Game Master thinks before it answers. Many
                    models want different settings with thinking off.
                  </small>
                </label>
                <div class="wide">
                  <TemperamentCard
                    model={selected}
                    reasoning={reasoning}
                    almanac={almanac}
                    drafts={drafts}
                    onDraft={(key, text) => setDrafts({ ...drafts, [key]: text })}
                    onClearDrafts={() =>
                      setDrafts(
                        drafts.fitTarget ? { fitTarget: drafts.fitTarget } : {},
                      )
                    }
                    onOpenAlmanac={(entryId) => setAlmanacAt(entryId ?? null)}
                  />
                </div>
                <details class="home-advanced">
                  <summary>Memory and engine</summary>
                  <div class="home-advanced-body">
                    {props.mmproj.length > 0 ? (
                      <label class="wide">
                        Vision projector
                        <select
                          value={mmproj}
                          onChange={(event) =>
                            setMmproj(event.currentTarget.value)
                          }
                        >
                          <option value="">None</option>
                          {props.mmproj.map((file) => (
                            <option key={file.path} value={file.path}>
                              {file.name}
                              {file.size !== undefined
                                ? ` — ${formatModelSize(file.size)}`
                                : ""}
                            </option>
                          ))}
                        </select>
                        <small>
                          Loads an mmproj file so the Game Master can see
                          images.
                        </small>
                      </label>
                    ) : null}
                    <label>
                      Context window
                      <span class="home-settings-unit">
                        <input
                          type="number"
                          min="4096"
                          max="10000000"
                          step="1024"
                          value={contextTokens}
                          onInput={(event) => {
                            const parsed = partialNumber(
                              event.currentTarget.value,
                            );
                            if (parsed !== undefined) setContextTokens(parsed);
                          }}
                        />
                        <span>tokens</span>
                      </span>
                      <small>Higher values reserve more GPU memory.</small>
                    </label>
                    <label>
                      Reasoning budget
                      <span class="home-settings-unit">
                        <input
                          type="number"
                          min="-1"
                          max="10000000"
                          step="1"
                          value={reasoningTokens}
                          onInput={(event) => {
                            const parsed = partialNumber(
                              event.currentTarget.value,
                            );
                            if (parsed !== undefined)
                              setReasoningTokens(parsed);
                          }}
                        />
                        <span>tokens</span>
                      </span>
                      <small>Use -1 for unrestricted thinking.</small>
                    </label>
                    <label>
                      Key cache
                      <select
                        value={flashAttention || onExl3 ? cacheK : "f16"}
                        disabled={!flashAttention && !onExl3}
                        onChange={(event) =>
                          setCacheK(event.currentTarget.value)
                        }
                      >
                        {CACHE_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                      <small>
                        Keep q8_0, or try q4_0 for more context. A turbo key
                        cache degrades models with few KV heads.
                      </small>
                    </label>
                    <label>
                      Value cache
                      <select
                        value={flashAttention || onExl3 ? cacheV : "f16"}
                        disabled={!flashAttention && !onExl3}
                        onChange={(event) =>
                          setCacheV(event.currentTarget.value)
                        }
                      >
                        {CACHE_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                      <small>
                        turbo3 frees about 1 GiB over q8_0 at a long context,
                        at no measured cost in speed.
                        {onExl3
                          ? " exl3xpu keeps f16 when both caches are f16, and fp8 for any other choice."
                          : ""}
                      </small>
                    </label>
                    {onExl3 ? (
                    <>
                    <label>
                      Games at once
                      <input
                        type="number"
                        min="1"
                        max="16"
                        step="1"
                        value={parallel}
                        onInput={(event) => {
                          const parsed = partialNumber(event.currentTarget.value);
                          if (parsed !== undefined) setParallel(parsed);
                        }}
                      />
                      <small>
                        Requests the engine answers side by side, for players
                        sharing this computer. They share the card's cache.
                      </small>
                    </label>
                    <label>
                      RAM cache
                      <span class="home-settings-unit">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={ramCacheGiB}
                          onInput={(event) => {
                            const parsed = partialNumber(event.currentTarget.value);
                            if (parsed !== undefined) setRamCacheGiB(parsed);
                          }}
                        />
                        <span>GiB</span>
                      </span>
                      <small>
                        System RAM that keeps a waiting game's cache, so its
                        next turn copies it back instead of re-reading the
                        whole prompt. 0 turns it off. At most half your RAM;
                        on Intel it rounds down to 8, 16 or 32 GiB.
                      </small>
                    </label>
                    </>
                    ) : null}
                    <label>
                      {fitTarget.label}
                      <span class="home-settings-unit">
                        <input
                          type="number"
                          min={fitTarget.min}
                          max={fitTarget.max}
                          step={1}
                          value={drafts.fitTarget ?? ""}
                          placeholder={String(fitTarget.fallback)}
                          onInput={(event) =>
                            setDrafts({
                              ...drafts,
                              fitTarget: event.currentTarget.value,
                            })
                          }
                        />
                        <span>MiB</span>
                      </span>
                      <small>{fitTarget.help}</small>
                    </label>
                    {onExl3 ? null : (
                    <>
                    <label class="home-settings-check wide">
                      <input
                        type="checkbox"
                        checked={!kvOffload}
                        onChange={(event) =>
                          setKvOffload(!event.currentTarget.checked)
                        }
                      />
                      Keep the cache in system RAM
                      <small>
                        Frees card memory for the weights. Generation measured
                        about four times slower.
                      </small>
                    </label>
                    <label class="home-settings-check wide">
                      <input
                        type="checkbox"
                        checked={!flashAttention}
                        onChange={(event) =>
                          setFlashAttention(!event.currentTarget.checked)
                        }
                      />
                      Turn off flash attention
                      <small>
                        Much faster long prompts on Intel Arc, whose driver
                        cannot run flash attention quickly. Both caches become
                        f16, which takes more memory.
                      </small>
                    </label>
                    </>
                    )}
                  </div>
                </details>
              </fieldset>
              <div class="home-settings-actions">
                <button
                  type="button"
                  onClick={props.onClose}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="primary"
                  disabled={submitting || !model || !exl3Ready}
                >
                  {submitting ? "Warming…" : "Load Game Master"}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
