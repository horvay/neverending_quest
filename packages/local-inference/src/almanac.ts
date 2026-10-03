/**
 * The Almanac: recommended sampling for each family of local model, and the
 * Auto mode that picks an entry for the model being loaded.
 *
 * Built-in entries transcribe the sampler values from a community cheat sheet
 * (https://huggingface.co/spaces/overhead520/LLM-Settings-Guide), one per base
 * family; a finetune uses its base's entry. The player's own entries ("yours")
 * sit in front of them: an entry can carry its own values, or only point at
 * another entry ("built on"), which is how a finetune Auto misreads is fixed.
 *
 * Pure: no Node, so the Home page resolves the same values the engine gets.
 */
import {
  LOCAL_TUNING_FIELDS,
  parseLocalTuning,
  type LocalTuning,
  type LocalTuningKey,
} from "./tuning.ts";

export type AlmanacMode = "thinking" | "plain";

export type AlmanacMatch = {
  /** GGUF `general.architecture` values this entry recognises. */
  architecture?: string[];
  /**
   * Name patterns (`*` any run, `?` one character) tried against the file
   * name, the header's name fields and its base models. Case and the
   * separators ` `, `_` and `-` are ignored.
   */
  names?: string[];
};

export type AlmanacEntry = {
  id: string;
  title: string;
  /** Who made the family; groups the built-in list. */
  maker?: string;
  source: "built-in" | "yours";
  match: AlmanacMatch;
  /** Another entry whose values fill in whatever this one leaves unset. */
  extends?: string;
  /** Values whatever the thinking level. */
  values?: LocalTuning;
  /** Values only while the Game Master thinks. */
  thinking?: LocalTuning;
  /** Values only while thinking is off. */
  plain?: LocalTuning;
  notes?: string[];
};

/** What Auto knows about an installed model. */
export type ModelIdentity = {
  /** The GGUF file name without `.gguf`. */
  file: string;
  alias: string;
  architecture?: string;
  name?: string;
  basename?: string;
  finetune?: string;
  sizeLabel?: string;
  baseModels: string[];
};

export const GENERAL_ENTRY_ID = "general";

const T = (
  temperature?: number,
  topP?: number,
  extra: LocalTuning = {},
): LocalTuning => ({
  ...(temperature !== undefined ? { temperature } : {}),
  ...(topP !== undefined ? { topP } : {}),
  ...extra,
});

const KV_NOTE = "Keep the key and value caches unquantized (f16 or q8_0): a compressed cache sends this model into repetition loops.";

function builtIn(
  entry: Omit<AlmanacEntry, "source" | "match"> & { match?: AlmanacMatch },
): AlmanacEntry {
  return { ...entry, source: "built-in", match: entry.match ?? {} };
}

export const BUILT_IN_ALMANAC: readonly AlmanacEntry[] = [
  builtIn({
    id: GENERAL_ENTRY_ID,
    title: "General",
    values: T(1.0, 0.95, { minP: 0.05 }),
  }),
  builtIn({
    id: "olmo-3",
    title: "Olmo 3",
    maker: "Allen AI",
    match: { names: ["*olmo-3*", "*olmo3*"] },
    values: T(0.6, 0.95),
  }),
  builtIn({
    id: "qwen-2.5",
    title: "Qwen 2.5",
    maker: "Alibaba",
    match: { architecture: ["qwen2"], names: ["*qwen2.5*", "*qwen-2.5*"] },
    values: T(0.6, 1.0, { minP: 0 }),
  }),
  builtIn({
    id: "qwq",
    title: "QwQ",
    maker: "Alibaba",
    match: { names: ["*qwq*"] },
    values: T(0.6, 0.95, { topK: 40, repeatPenalty: 1.0 }),
  }),
  builtIn({
    id: "qwen-3",
    title: "Qwen 3",
    maker: "Alibaba",
    match: { architecture: ["qwen3", "qwen3moe"], names: ["*qwen3-*", "*qwen-3-*"] },
    thinking: T(0.6, 0.95, { topK: 20, minP: 0, presencePenalty: 0 }),
    plain: T(0.7, 0.8, { topK: 20, minP: 0, presencePenalty: 1.5 }),
  }),
  builtIn({
    id: "qwen-3-30b-a3b",
    title: "Qwen 3 30B-A3B",
    maker: "Alibaba",
    match: { names: ["*qwen3-30b-a3b*"] },
    extends: "qwen-3",
    notes: [KV_NOTE],
  }),
  builtIn({
    id: "qwen-3-next",
    title: "Qwen 3 Next",
    maker: "Alibaba",
    match: { architecture: ["qwen3next"], names: ["*qwen3-next*"] },
    values: T(0.7),
  }),
  builtIn({
    id: "qwen-3-coder-next",
    title: "Qwen 3 Coder Next",
    maker: "Alibaba",
    match: { names: ["*qwen3-coder-next*"] },
    values: T(1.0, 0.95, { topK: 40 }),
  }),
  builtIn({
    id: "qwen-3-vl-thinking",
    title: "Qwen 3 VL Thinking",
    maker: "Alibaba",
    match: { names: ["*qwen3-vl*thinking*"] },
    values: T(1.0, 0.95, { topK: 20, presencePenalty: 0 }),
  }),
  builtIn({
    id: "qwen-3-vl-instruct",
    title: "Qwen 3 VL Instruct",
    maker: "Alibaba",
    match: { names: ["*qwen3-vl*instruct*"] },
    values: T(0.7, 0.8, { topK: 20, presencePenalty: 1.5 }),
  }),
  builtIn({
    id: "qwen-3.5",
    title: "Qwen 3.5",
    maker: "Alibaba",
    match: { architecture: ["qwen35", "qwen35moe"], names: ["*qwen3.5*"] },
    values: T(1.0, 0.95, { topK: 20, minP: 0, presencePenalty: 1.5 }),
  }),
  builtIn({
    id: "qwen-3.6",
    title: "Qwen 3.6",
    maker: "Alibaba",
    match: { architecture: ["qwen35", "qwen35moe"], names: ["*qwen3.6*"] },
    values: T(1.0, 0.95, {
      topK: 20,
      minP: 0,
      presencePenalty: 0,
      repeatPenalty: 1.0,
    }),
  }),
  builtIn({
    id: "qwen-3.8",
    title: "Qwen 3.8",
    maker: "Alibaba",
    match: { architecture: ["qwen35", "qwen35moe"], names: ["*qwen3.8*"] },
    thinking: T(1.0, 0.95, { topK: 20, minP: 0, presencePenalty: 0 }),
    plain: T(0.7, 0.8, { topK: 20, minP: 0, presencePenalty: 1.5 }),
  }),
  builtIn({
    id: "seed-oss",
    title: "Seed-OSS",
    maker: "ByteDance",
    match: { architecture: ["seed_oss"], names: ["*seed-oss*"] },
    values: T(1.1, 0.8, { topK: 20, minP: 0 }),
    notes: ["Presence penalty anywhere from 0 to 2 suits it."],
  }),
  builtIn({
    id: "command-a",
    title: "Command-A",
    maker: "Cohere",
    match: { architecture: ["cohere2"], names: ["*command-a*"] },
    values: T(0.3, 0.05),
  }),
  builtIn({
    id: "deepseek-v3",
    title: "DeepSeek V3 & R1",
    maker: "DeepSeek",
    match: { names: ["*deepseek-v3*", "*deepseek-r1*"] },
    values: T(0.3, 0.95),
  }),
  builtIn({
    id: "deepseek-v3.1",
    title: "DeepSeek V3.1",
    maker: "DeepSeek",
    match: { names: ["*deepseek-v3.1*"] },
    values: T(0.6, 0.95),
  }),
  builtIn({
    id: "deepseek-v3.2",
    title: "DeepSeek V3.2",
    maker: "DeepSeek",
    match: { names: ["*deepseek-v3.2*"] },
    values: T(1.0, 0.95),
  }),
  builtIn({
    id: "deepseek-v4",
    title: "DeepSeek V4",
    maker: "DeepSeek",
    match: { architecture: ["deepseek4"], names: ["*deepseek-v4*"] },
    values: T(1.5, 1.0),
    notes: [
      "1.5 is the temperature for creative writing and roleplay; 1.3 suits conversation.",
    ],
  }),
  builtIn({
    id: "exaone-4",
    title: "EXAONE 4",
    maker: "LG",
    match: { architecture: ["exaone4"], names: ["*exaone-4*", "*exaone4*"] },
    values: T(0.6, 0.95),
    notes: [
      "Without thinking, keep the temperature below 0.6.",
      "If it degenerates, a presence penalty of 1.5 helps.",
    ],
  }),
  builtIn({
    id: "gemma-3",
    title: "Gemma 3",
    maker: "Google",
    match: { architecture: ["gemma3"], names: ["*gemma-3*", "*gemma3*"] },
    values: T(1.0, 0.95, { topK: 64, minP: 0, repeatPenalty: 1.0 }),
  }),
  builtIn({
    id: "gemma-4",
    title: "Gemma 4",
    maker: "Google",
    match: { architecture: ["gemma4"], names: ["*gemma-4*", "*gemma4*"] },
    values: T(1.0, 0.95, { topK: 64, minP: 0, repeatPenalty: 1.0 }),
    notes: [
      "For roleplay, a temperature up to 1.5 gives more variety between retellings.",
    ],
  }),
  builtIn({
    id: "glm-4",
    title: "GLM 4",
    maker: "Z.AI",
    match: { architecture: ["glm4"], names: ["*glm-4-*", "*glm4-*"] },
    values: T(1.0, undefined, { minP: 0.1, repeatPenalty: 1.03 }),
  }),
  builtIn({
    id: "glm-4.5",
    title: "GLM 4.5",
    maker: "Z.AI",
    match: { names: ["*glm-4.5*"] },
    values: T(0.7, 0.92),
  }),
  builtIn({
    id: "glm-4.6",
    title: "GLM 4.6",
    maker: "Z.AI",
    match: { names: ["*glm-4.6*"] },
    values: T(1.0, 0.92),
  }),
  builtIn({
    id: "glm-4.6v",
    title: "GLM 4.6V",
    maker: "Z.AI",
    match: { names: ["*glm-4.6v*"] },
    values: T(0.8, 0.6, { topK: 2, repeatPenalty: 1.1 }),
  }),
  builtIn({
    id: "glm-4.7",
    title: "GLM 4.7",
    maker: "Z.AI",
    match: { names: ["*glm-4.7*"] },
    values: T(1.0, 0.95),
  }),
  builtIn({
    id: "glm-4.7-flash",
    title: "GLM 4.7 Flash",
    maker: "Z.AI",
    match: { names: ["*glm-4.7-flash*"] },
    values: T(1.0, 0.95, { topK: 50, repeatPenalty: 1.0 }),
  }),
  builtIn({
    id: "glm-5",
    title: "GLM 5",
    maker: "Z.AI",
    match: { names: ["*glm-5*"] },
    values: T(1.0, 0.95, { minP: 0.05 }),
  }),
  builtIn({
    id: "gpt-oss",
    title: "GPT-OSS",
    maker: "OpenAI",
    match: { architecture: ["gpt-oss"], names: ["*gpt-oss*"] },
    values: T(1.0, 1.0, { topK: 0 }),
  }),
  builtIn({
    id: "hermes-4",
    title: "Hermes 4.3",
    maker: "Nous Research",
    match: { names: ["*hermes-4*"] },
    values: T(0.6, 0.95, { topK: 20 }),
  }),
  builtIn({
    id: "kimi-k2",
    title: "Kimi K2",
    maker: "Moonshot AI",
    match: { names: ["*kimi-k2*"] },
    values: T(0.6, undefined, { minP: 0.01 }),
  }),
  builtIn({
    id: "lfm2",
    title: "LFM2",
    maker: "Liquid AI",
    match: { architecture: ["lfm2"], names: ["*lfm2*"] },
    values: T(0.05, undefined, { topK: 50, repeatPenalty: 1.05 }),
  }),
  builtIn({
    id: "ling-flash-2",
    title: "Ling Flash 2.0",
    maker: "Inclusion AI",
    match: { names: ["*ling-flash-2*"] },
    values: T(0.7, 0.8),
  }),
  builtIn({
    id: "ling-1t",
    title: "Ling 1T",
    maker: "Inclusion AI",
    match: { names: ["*ling-1t*"] },
    values: T(0.7, 0.95),
  }),
  builtIn({
    id: "llama-4",
    title: "Llama 4",
    maker: "Meta",
    match: { architecture: ["llama4"], names: ["*llama-4*", "*llama4*"] },
    values: T(0.6, 0.9, { minP: 0.01 }),
  }),
  builtIn({
    id: "mimo-2-flash",
    title: "MiMo 2 Flash",
    maker: "Xiaomi",
    match: { names: ["*mimo-v2-flash*", "*mimo-2-flash*"] },
    values: T(0.8, 0.95),
  }),
  builtIn({
    id: "mimo-2.5",
    title: "MiMo 2.5",
    maker: "Xiaomi",
    match: { names: ["*mimo-v2.5*", "*mimo-2.5*"] },
    values: T(1.0, 0.95),
  }),
  builtIn({
    id: "minimax-m2",
    title: "MiniMax M2",
    maker: "MiniMax",
    match: { architecture: ["minimax-m2"], names: ["*minimax-m2*"] },
    values: T(1.0, 0.95, { topK: 40 }),
  }),
  builtIn({
    id: "devstral-2",
    title: "Devstral 2",
    maker: "Mistral AI",
    match: { names: ["*devstral-2*"] },
    values: T(0.15, undefined, { minP: 0.01 }),
  }),
  builtIn({
    id: "ministral-3",
    title: "Ministral 3",
    maker: "Mistral AI",
    match: { names: ["*ministral-3*"] },
    thinking: T(0.7, 0.95),
    plain: T(0.15, 1.0),
  }),
  builtIn({
    id: "mistral-large",
    title: "Mistral Large",
    maker: "Mistral AI",
    match: { names: ["*mistral-large*"] },
    values: T(0.7),
    notes: [KV_NOTE],
  }),
  builtIn({
    id: "mistral-small-3",
    title: "Mistral Small 3",
    maker: "Mistral AI",
    match: { names: ["*mistral-small-3*"] },
    values: T(0.15),
    notes: ["Tends to write walls of text; ask for concise replies."],
  }),
  builtIn({
    id: "mistral-small-4",
    title: "Mistral Small 4",
    maker: "Mistral AI",
    match: { names: ["*mistral-small-4*"] },
    values: T(0.7),
    notes: ["Without thinking, anywhere from 0 to 0.7 works."],
  }),
  builtIn({
    id: "nemotron-super-49b",
    title: "Nemotron Super 49B",
    maker: "Nvidia",
    match: { names: ["*nemotron-super-49b*"] },
    values: T(0.6, 0.95),
  }),
  builtIn({
    id: "nemotron-3-super",
    title: "Nemotron 3 Super",
    maker: "Nvidia",
    match: { names: ["*nemotron-3-super*"] },
    values: T(1.0, 0.95, { minP: 0.05 }),
  }),
  builtIn({
    id: "nemotron-3-nano",
    title: "Nemotron 3 Nano",
    maker: "Nvidia",
    match: { names: ["*nemotron-3-nano*"] },
    values: T(1.0, 1.0),
  }),
  builtIn({
    id: "phi-4",
    title: "Phi-4",
    maker: "Microsoft",
    match: { names: ["*phi-4*"] },
    values: T(1.0, 1.0, { minP: 0 }),
  }),
  builtIn({
    id: "bonsai",
    title: "1-bit Bonsai",
    maker: "Prism ML",
    match: { names: ["*bonsai*"] },
    values: T(0.5, 0.9, { topK: 20, repeatPenalty: 1.0, presencePenalty: 0 }),
    notes: ["Suggested ranges: temperature 0.5–0.7, Top-K 20–40, Top-P 0.85–0.96."],
  }),
  // the guide's Bonsai values are for the first 1-bit Bonsai; Bonsai 2 is a
  // Qwen 3.8 derivative and ships Qwen 3.8's chat template
  builtIn({
    id: "bonsai-2",
    title: "Bonsai 2",
    maker: "Prism ML",
    match: { names: ["*bonsai-2*"] },
    extends: "qwen-3.8",
  }),
  builtIn({
    id: "apriel-nemotron",
    title: "Apriel-Nemotron Thinker",
    maker: "ServiceNow & Nvidia",
    match: { names: ["*apriel*"] },
    values: T(0.6, 0.9, { topK: 20, minP: 0.05 }),
    notes: [KV_NOTE],
  }),
  builtIn({
    id: "step-3.5-flash",
    title: "Step 3.5 Flash",
    maker: "StepFun",
    match: { names: ["*step-3.5-flash*", "*step3.5-flash*"] },
    values: T(1.0, 0.95),
  }),
  builtIn({
    id: "apertus",
    title: "Apertus",
    maker: "Swiss AI",
    match: { names: ["*apertus*"] },
    values: T(0.8, 0.9),
  }),
  builtIn({
    id: "hy-3",
    title: "HY 3",
    maker: "Tencent",
    match: { names: ["*hy-3*", "*hy3*"] },
    values: T(0.9, 1.0),
  }),
];

/** Lower case, with runs of space, `_` and `-` read as one `-`. */
export function normalizeModelName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function globRegex(pattern: string): RegExp {
  const body = normalizeModelName(pattern)
    .split("")
    .map((ch) =>
      ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${body}$`);
}

/** Everything a name pattern is tried against. */
export function identityNames(identity: ModelIdentity): string[] {
  return [
    identity.file,
    identity.alias,
    identity.name,
    identity.basename,
    ...identity.baseModels,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizeModelName);
}

/** How strongly an entry recognises a model; 0 means not at all. */
export type AlmanacHit = {
  entry: AlmanacEntry;
  /** True when a name pattern matched, not just the architecture. */
  byName: boolean;
  /** The pattern that matched, if any. */
  pattern?: string;
  /** What it matched: "file name", "base model", and so on. */
  on?: string;
  score: number;
};

function literalLength(pattern: string): number {
  return normalizeModelName(pattern).replace(/[*?]/g, "").length;
}

/** Tests one entry against a model. */
export function matchEntry(
  entry: AlmanacEntry,
  identity: ModelIdentity,
): AlmanacHit | undefined {
  const { architecture, names } = entry.match;
  if (!architecture?.length && !names?.length) return undefined;
  const archHit =
    !!identity.architecture &&
    !!architecture?.some(
      (arch) => arch.toLowerCase() === identity.architecture!.toLowerCase(),
    );
  // an entry that names architectures only recognises those architectures
  if (architecture?.length && !names?.length && !archHit) return undefined;
  const labelled: Array<[string, string]> = [
    ["file name", identity.file],
    ["file name", identity.alias],
    ["model name", identity.name ?? ""],
    ["model name", identity.basename ?? ""],
    ...identity.baseModels.map((base) => ["base model", base] as [string, string]),
  ];
  let best: { pattern: string; on: string } | undefined;
  for (const pattern of names ?? []) {
    const regex = globRegex(pattern);
    const hit = labelled.find(([, text]) => text && regex.test(normalizeModelName(text)));
    if (!hit) continue;
    if (!best || literalLength(pattern) > literalLength(best.pattern)) {
      best = { pattern, on: hit[0] };
    }
  }
  if (!best && !archHit) return undefined;
  // a named family beats an architecture alone, and a longer name beats a
  // shorter one ("qwen3-vl*instruct" over "qwen3-"); the player's own
  // entries go in front of the book's
  const score =
    (best ? 1000 + literalLength(best.pattern) * 10 : 0) +
    (archHit ? 1 : 0) +
    (entry.source === "yours" ? 5000 : 0);
  return {
    entry,
    byName: Boolean(best),
    ...(best ? { pattern: best.pattern, on: best.on } : {}),
    score,
  };
}

export type AlmanacRecognition = {
  /** The entry Auto uses. */
  entry: AlmanacEntry;
  /**
   * `named`: a name pattern matched. `guessed`: only the architecture did,
   * so Auto should ask. `unknown`: nothing did; General applies.
   */
  confidence: "named" | "guessed" | "unknown";
  hit?: AlmanacHit;
  /** Other entries that recognise the model, best first. */
  alternatives: AlmanacHit[];
};

/**
 * The whole Almanac. Given only the player's entries, the book's are added
 * from this build; a list that already carries the book (as the Home page
 * gets it from the server) is used as it is, so a page built from older code
 * still reads the server's book.
 */
export function allEntries(entries: readonly AlmanacEntry[]): AlmanacEntry[] {
  return entries.some((entry) => entry.source === "built-in")
    ? [...entries]
    : [...entries, ...BUILT_IN_ALMANAC];
}

export function findEntry(
  id: string | undefined,
  entries: readonly AlmanacEntry[],
): AlmanacEntry | undefined {
  if (!id) return undefined;
  return allEntries(entries).find((entry) => entry.id === id);
}

/** Which entry Auto uses for a model. */
export function recognizeModel(
  identity: ModelIdentity,
  yours: readonly AlmanacEntry[],
): AlmanacRecognition {
  const hits = allEntries(yours)
    .map((entry) => matchEntry(entry, identity))
    .filter((hit): hit is AlmanacHit => hit !== undefined)
    .sort((a, b) => b.score - a.score);
  const [top, ...rest] = hits;
  if (!top) {
    return {
      entry: findEntry(GENERAL_ENTRY_ID, yours)!,
      confidence: "unknown",
      alternatives: [],
    };
  }
  // several families share one architecture (qwen35 is Qwen 3.5 to 3.8 and
  // their finetunes), so an architecture alone is only a guess
  const confidence = top.byName || top.entry.source === "yours" ? "named" : "guessed";
  return { entry: top.entry, confidence, hit: top, alternatives: rest };
}

/** The entries an entry inherits from, itself first. Cycles stop the walk. */
export function entryChain(
  entry: AlmanacEntry,
  yours: readonly AlmanacEntry[],
): AlmanacEntry[] {
  const chain: AlmanacEntry[] = [];
  const seen = new Set<string>();
  let current: AlmanacEntry | undefined = entry;
  while (current && !seen.has(current.id)) {
    chain.push(current);
    seen.add(current.id);
    current = findEntry(current.extends, yours);
  }
  return chain;
}

export type TuningSource =
  | { kind: "yours" }
  | { kind: "entry"; entryId: string; title: string; yours: boolean }
  | { kind: "model-file" }
  | { kind: "engine" };

export type ResolvedKnob = { value: number; source: TuningSource };

export type AutoTuning = {
  recognition: AlmanacRecognition;
  mode: AlmanacMode;
  knobs: Record<LocalTuningKey, ResolvedKnob>;
  /** What the engine is launched with: every value not left to its own defaults. */
  tuning: LocalTuning;
  notes: Array<{ entryId: string; title: string; text: string }>;
};

function entryValues(entry: AlmanacEntry, mode: AlmanacMode): LocalTuning {
  return { ...entry.values, ...entry[mode] };
}

/** The Game Master thinks unless its thinking level is off. */
export function almanacMode(reasoning: string | undefined): AlmanacMode {
  return reasoning?.trim().toLowerCase() === "off" ? "plain" : "thinking";
}

/**
 * Resolves every knob for one model, highest first: the player's own value,
 * then the entry Auto chose and whatever it is built on, then the model
 * file's own `general.sampling`, then the General entry, then the engine's
 * default. The model file ranks below a recognised entry because GGUFs
 * mostly copy their base model's generation config, whatever the finetune.
 */
export function resolveAutoTuning(opts: {
  identity: ModelIdentity;
  yours: readonly AlmanacEntry[];
  reasoning?: string;
  /** The model file's own sampling recommendations. */
  modelFile?: LocalTuning;
  /** The player's values for this model. */
  overrides?: LocalTuning;
}): AutoTuning {
  const recognition = recognizeModel(opts.identity, opts.yours);
  const mode = almanacMode(opts.reasoning);
  const chain = entryChain(recognition.entry, opts.yours).filter(
    (entry) => entry.id !== GENERAL_ENTRY_ID,
  );
  const general = findEntry(GENERAL_ENTRY_ID, opts.yours)!;
  const knobs = {} as Record<LocalTuningKey, ResolvedKnob>;
  const tuning: LocalTuning = {};
  for (const field of LOCAL_TUNING_FIELDS) {
    const key = field.key;
    let knob: ResolvedKnob | undefined;
    const own = opts.overrides?.[key];
    if (own !== undefined) knob = { value: own, source: { kind: "yours" } };
    for (const entry of chain) {
      if (knob) break;
      const value = entryValues(entry, mode)[key];
      if (value !== undefined) {
        knob = {
          value,
          source: {
            kind: "entry",
            entryId: entry.id,
            title: entry.title,
            yours: entry.source === "yours",
          },
        };
      }
    }
    const fromFile = opts.modelFile?.[key];
    if (!knob && fromFile !== undefined) {
      knob = { value: fromFile, source: { kind: "model-file" } };
    }
    const fromGeneral = entryValues(general, mode)[key];
    if (!knob && fromGeneral !== undefined) {
      knob = {
        value: fromGeneral,
        source: { kind: "entry", entryId: general.id, title: general.title, yours: false },
      };
    }
    knob ??= { value: field.fallback, source: { kind: "engine" } };
    knobs[key] = knob;
    if (knob.source.kind === "yours" || knob.source.kind === "entry") {
      tuning[key] = knob.value;
    }
  }
  const notes = [...chain, ...(chain.length === 0 ? [general] : [])].flatMap((entry) =>
    (entry.notes ?? []).map((text) => ({ entryId: entry.id, title: entry.title, text })),
  );
  return { recognition, mode, knobs, tuning, notes };
}

const QUANT_TAIL =
  /[-_. ]+(?:i1|imatrix|mtp|gguf|(?:i?q|pq|ptq|tq)\d[\w]*|f16|bf16|f32|mxfp4|\d+(?:\.\d+)?[-_ ]?bpw)(?=$|[-_. ])/gi;

/** A model's name without its quantization tags ("-Q4_K_M", ".i1", "PQ2_0"). */
export function stripQuantTags(name: string): string {
  let stem = name;
  let previous: string;
  do {
    previous = stem;
    stem = stem.replace(QUANT_TAIL, "");
  } while (stem !== previous);
  return stem.trim();
}

/**
 * A name pattern for "files named like this one": the file name without its
 * quantization tags, so other quants of the same model match too.
 */
export function suggestNamePattern(identity: ModelIdentity): string {
  const normalized =
    normalizeModelName(stripQuantTags(identity.file)) ||
    normalizeModelName(identity.alias);
  return `*${normalized}*`;
}

/** Architectures and families the built-in list knows, for pickers. */
export function knownArchitectures(): string[] {
  return [
    ...new Set(BUILT_IN_ALMANAC.flatMap((entry) => entry.match.architecture ?? [])),
  ].sort();
}

const ID_SAFE = /[^a-z0-9.-]+/g;

/** A fresh id for a player's entry. */
export function newEntryId(title: string, taken: readonly AlmanacEntry[]): string {
  const base = `yours-${normalizeModelName(title).replace(ID_SAFE, "") || "entry"}`;
  const ids = new Set([...taken.map((entry) => entry.id), ...BUILT_IN_ALMANAC.map((e) => e.id)]);
  if (!ids.has(base)) return base;
  for (let i = 2; ; i += 1) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
}

function stringList(raw: unknown, max: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
  return list.length > 0 ? list : undefined;
}

function tuningOrUndefined(raw: unknown): LocalTuning | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const tuning = parseLocalTuning(raw as Record<string, unknown>);
  return Object.keys(tuning).length > 0 ? tuning : undefined;
}

/**
 * Reads one of the player's entries from untrusted JSON (the Almanac file or
 * the Home page). Out-of-range values are dropped by the knob table.
 */
export function parseAlmanacEntry(raw: unknown): AlmanacEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const title = typeof record.title === "string" ? record.title.trim().slice(0, 120) : "";
  if (!id || !/^[a-z0-9][a-z0-9.-]*$/.test(id) || !title) return undefined;
  if (BUILT_IN_ALMANAC.some((entry) => entry.id === id)) return undefined;
  const matchRaw =
    record.match && typeof record.match === "object" && !Array.isArray(record.match)
      ? (record.match as Record<string, unknown>)
      : {};
  const architecture = stringList(matchRaw.architecture, 8)?.map((a) => a.toLowerCase());
  const names = stringList(matchRaw.names, 12);
  const values = tuningOrUndefined(record.values);
  const thinking = tuningOrUndefined(record.thinking);
  const plain = tuningOrUndefined(record.plain);
  const notes = stringList(record.notes, 8)?.map((note) => note.slice(0, 400));
  const extendsId =
    typeof record.extends === "string" && record.extends.trim() && record.extends !== id
      ? record.extends.trim()
      : undefined;
  return {
    id,
    title,
    source: "yours",
    match: {
      ...(architecture ? { architecture } : {}),
      ...(names ? { names } : {}),
    },
    ...(extendsId ? { extends: extendsId } : {}),
    ...(values ? { values } : {}),
    ...(thinking ? { thinking } : {}),
    ...(plain ? { plain } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** The player's entries from the Almanac file, skipping any that are malformed. */
export function parseAlmanacFile(raw: unknown): AlmanacEntry[] {
  const list =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).entries
      : undefined;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const entries: AlmanacEntry[] = [];
  for (const item of list) {
    const entry = parseAlmanacEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

/** The file form: built-in fields like `source` are implied, not stored. */
export function almanacFileText(entries: readonly AlmanacEntry[]): string {
  return `${JSON.stringify(
    {
      schema: 1,
      entries: entries.map(({ source: _source, ...rest }) => rest),
    },
    null,
    2,
  )}\n`;
}
