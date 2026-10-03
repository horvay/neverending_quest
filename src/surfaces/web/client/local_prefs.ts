/**
 * The local Game Master panel remembers its last model, thinking level and
 * sampling values in the browser. Engine choices (context, caches, card) are
 * each model's server-side profile instead, so they follow the model.
 */

import {
  compactLegacyLocalTuning,
  parseLocalTuning,
  type LocalTuning,
} from "@nq/local-inference/tuning.ts";

const STORAGE_KEY = "nq.local-model-settings";

export type LocalModelPrefs = {
  model?: string;
  reasoning?: string;
  /** Only the knobs the player set; the rest follow the model. */
  tuning?: LocalTuning;
  /**
   * The player's own values for each model, by selector. Auto fills the
   * rest, and it picks per model, so one model's values stay with it.
   */
  tuningByModel?: Record<string, LocalTuning>;
};

/** Marks a selection whose tuning holds only set knobs, not every knob. */
const TUNING_FORMAT = 2;

/**
 * Reads the remembered selection. Storage is absent in a server render and
 * throws outright when the browser blocks site data, so every access is
 * guarded and an empty selection is a normal result.
 */
export function readLocalModelPrefs(): LocalModelPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const value = parsed as Record<string, unknown>;
    return {
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(typeof value.reasoning === "string"
        ? { reasoning: value.reasoning }
        : {}),
      ...(value.tuningByModel &&
      typeof value.tuningByModel === "object" &&
      !Array.isArray(value.tuningByModel)
        ? {
            tuningByModel: Object.fromEntries(
              Object.entries(value.tuningByModel as Record<string, unknown>).map(
                ([model, tuning]) => [
                  model,
                  parseLocalTuning(tuning as Record<string, unknown> | undefined),
                ],
              ),
            ),
          }
        : {}),
      tuning:
        value.tuningFormat === TUNING_FORMAT
          ? parseLocalTuning(value.tuning as Record<string, unknown> | undefined)
          : compactLegacyLocalTuning(
              parseLocalTuning(value.tuning as Record<string, unknown> | undefined),
            ),
    };
  } catch {
    return {};
  }
}

/** Stores the selection that was just submitted. Failures are not worth surfacing. */
export function writeLocalModelPrefs(prefs: LocalModelPrefs): void {
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...prefs, tuningFormat: TUNING_FORMAT }),
    );
  } catch {
    // a private window or blocked site data simply forgets the selection
  }
}
