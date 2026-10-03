/**
 * Sampling and offload knobs NQ hands Atomic when it launches the engine.
 *
 * llama-server applies these as its own defaults, and OMP omits every sampling
 * field from the request body unless the player set one, so a flag here
 * governs the whole session. They are passed explicitly rather than left
 * implicit: a run should be reproducible from the profile alone, and the
 * engine's built-in defaults have moved between releases.
 *
 * A knob the player has not set takes the model's own recommendation when its
 * GGUF carries one (`general.sampling.*`), else Atomic's default.
 */

export type LocalTuningKey =
  | "temperature"
  | "topK"
  | "topP"
  | "minP"
  | "repeatPenalty"
  | "repeatLastN"
  | "presencePenalty"
  | "frequencyPenalty"
  | "dryMultiplier"
  | "dryBase"
  | "fitTarget";

export type LocalTuningField = {
  key: LocalTuningKey;
  /** llama-server flag the value is passed as */
  flag: string;
  /** key under [local] in nq.toml */
  config: string;
  label: string;
  help: string;
  min: number;
  max: number;
  /** Atomic's own default, kept in step with common/common.h */
  fallback: number;
  /** The model's recommendation under `general.sampling.<gguf>`, if any */
  gguf?: string;
  integer?: true;
};

export const LOCAL_TUNING_FIELDS: readonly LocalTuningField[] = [
  {
    key: "temperature",
    gguf: "temp",
    flag: "--temp",
    config: "temperature",
    label: "Temperature",
    help: "Higher is more surprising prose. 0 samples the single likeliest token.",
    min: 0,
    max: 2,
    fallback: 0.8,
  },
  {
    key: "topK",
    gguf: "top_k",
    flag: "--top-k",
    config: "top_k",
    label: "Top-K",
    help: "Keeps only this many candidates. 0 keeps the whole vocabulary.",
    min: 0,
    max: 1000,
    fallback: 40,
    integer: true,
  },
  {
    key: "topP",
    gguf: "top_p",
    flag: "--top-p",
    config: "top_p",
    label: "Top-P",
    help: "Keeps the likeliest candidates up to this mass. 1 keeps them all.",
    min: 0,
    max: 1,
    fallback: 0.95,
  },
  {
    key: "minP",
    gguf: "min_p",
    flag: "--min-p",
    config: "min_p",
    label: "Min-P",
    help: "Drops candidates below this share of the best one. 0 keeps them all.",
    min: 0,
    max: 1,
    fallback: 0.05,
  },
  {
    key: "repeatPenalty",
    gguf: "penalty_repeat",
    flag: "--repeat-penalty",
    config: "repeat_penalty",
    label: "Repeat penalty",
    help: "Above 1 discourages tokens already seen. 1 disables it.",
    min: 0.5,
    max: 2,
    fallback: 1,
  },
  {
    key: "repeatLastN",
    gguf: "penalty_last_n",
    flag: "--repeat-last-n",
    config: "repeat_last_n",
    label: "Repeat window",
    help: "How many recent tokens the repeat penalty looks at. 0 disables it.",
    min: 0,
    max: 8192,
    fallback: 64,
    integer: true,
  },
  {
    key: "presencePenalty",
    flag: "--presence-penalty",
    config: "presence_penalty",
    label: "Presence penalty",
    help: "A flat charge for reusing any token at all. 0 disables it.",
    min: 0,
    max: 2,
    fallback: 0,
  },
  {
    key: "frequencyPenalty",
    flag: "--frequency-penalty",
    config: "frequency_penalty",
    label: "Frequency penalty",
    help: "Charges a token more each time it reappears. 0 disables it.",
    min: 0,
    max: 2,
    fallback: 0,
  },
  {
    key: "dryMultiplier",
    flag: "--dry-multiplier",
    config: "dry_multiplier",
    label: "DRY strength",
    help: "Penalises whole repeated phrases, which plain repeat penalties miss. 0 disables it; 0.8 is a common setting.",
    min: 0,
    max: 5,
    fallback: 0,
  },
  {
    key: "dryBase",
    flag: "--dry-base",
    config: "dry_base",
    label: "DRY base",
    help: "How sharply the DRY penalty grows with the length of the repeat.",
    min: 1,
    max: 4,
    fallback: 1.75,
  },
  {
    key: "fitTarget",
    flag: "--fit-target",
    config: "fit_target",
    label: "VRAM headroom",
    help: "MiB left free on the card. Raise it when something else needs the GPU; lower it to fit more layers.",
    min: 0,
    max: 65_536,
    fallback: 300,
    integer: true,
  },
];

export const LOCAL_TUNING_KEYS = LOCAL_TUNING_FIELDS.map((field) => field.key);

export type LocalTuning = Partial<Record<LocalTuningKey, number>>;

const FIELD_BY_KEY = new Map(
  LOCAL_TUNING_FIELDS.map((field) => [field.key, field] as const),
);

/** Reads whichever knobs a record carries, ignoring anything out of range. */
export function parseLocalTuning(
  raw: Record<string, unknown> | undefined,
  read: (field: LocalTuningField) => unknown = (field) => raw?.[field.key],
): LocalTuning {
  const tuning: LocalTuning = {};
  for (const field of LOCAL_TUNING_FIELDS) {
    const value = Number(read(field));
    if (!Number.isFinite(value)) continue;
    if (value < field.min || value > field.max) continue;
    if (field.integer && !Number.isInteger(value)) continue;
    tuning[field.key] = value;
  }
  return tuning;
}

/**
 * Fills every unset knob, for display and for launch: the model's own
 * recommendation first, then Atomic's default.
 */
export function resolveLocalTuning(
  tuning: LocalTuning | undefined,
  modelDefaults?: LocalTuning,
): Record<LocalTuningKey, number> {
  const resolved = {} as Record<LocalTuningKey, number>;
  for (const field of LOCAL_TUNING_FIELDS) {
    resolved[field.key] =
      tuning?.[field.key] ?? modelDefaults?.[field.key] ?? field.fallback;
  }
  return resolved;
}

/** The flags for every knob, in table order. */
export function localTuningArgs(
  tuning: LocalTuning | undefined,
  modelDefaults?: LocalTuning,
): string[] {
  const resolved = resolveLocalTuning(tuning, modelDefaults);
  const args: string[] = [];
  for (const field of LOCAL_TUNING_FIELDS) {
    args.push(field.flag, String(resolved[field.key]));
  }
  return args;
}

/**
 * True when two profiles set the same knobs. An unset knob follows the model,
 * so it only matches another unset one.
 */
export function sameLocalTuning(
  left: LocalTuning | undefined,
  right: LocalTuning | undefined,
): boolean {
  return LOCAL_TUNING_KEYS.every((key) => left?.[key] === right?.[key]);
}

/**
 * Drops knobs equal to Atomic's default. Only for selections saved before a
 * knob could be left unset: those always wrote every knob, so a value equal
 * to the default was never a real choice.
 */
export function compactLegacyLocalTuning(
  tuning: LocalTuning | undefined,
): LocalTuning {
  const compact: LocalTuning = {};
  for (const field of LOCAL_TUNING_FIELDS) {
    const value = tuning?.[field.key];
    if (value !== undefined && value !== field.fallback)
      compact[field.key] = value;
  }
  return compact;
}

/**
 * Drops a whole saved profile. Before Auto, the load page saved every
 * sampling knob at once, so a record that sets all of them is the engine's
 * profile at the time, not values the player chose; kept, it would pin every
 * knob over Auto (and over the model's thinking-off values). VRAM headroom
 * is not sampling and is kept.
 */
export function dropSavedFullProfile(tuning: LocalTuning): LocalTuning {
  const samplers = LOCAL_TUNING_FIELDS.filter((field) => field.key !== "fitTarget");
  if (!samplers.every((field) => tuning[field.key] !== undefined)) return tuning;
  return tuning.fitTarget !== undefined ? { fitTarget: tuning.fitTarget } : {};
}

/** The model's own sampling recommendations from its GGUF metadata. */
export function ggufSamplingDefaults(
  values: ReadonlyMap<string, unknown>,
): LocalTuning {
  return parseLocalTuning(undefined, (field) => {
    const value = field.gguf
      ? values.get(`general.sampling.${field.gguf}`)
      : undefined;
    // stored as float32: 0.6 reads back as 0.6000000238418579
    return typeof value === "number" ? Number(value.toPrecision(7)) : value;
  });
}

export function localTuningField(key: LocalTuningKey): LocalTuningField {
  const field = FIELD_BY_KEY.get(key);
  if (!field) throw new Error(`Unknown local tuning key: ${key}`);
  return field;
}
