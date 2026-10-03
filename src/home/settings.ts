import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NqConfig } from "../config.ts";
import { REASONING_LEVELS } from "./fields.ts";
import {
  LOCAL_CACHE_TYPES,
  parseLocalGpuChoice,
  type LocalGpuChoice,
} from "@nq/local-inference/profile.ts";
import {
  LOCAL_TUNING_FIELDS,
  parseLocalTuning,
  type LocalTuning,
} from "@nq/local-inference/tuning.ts";

export { REASONING_LEVELS };

/**
 * How much of a local model's context a play session may fill before
 * rebuild-compaction. The rest is room for the reply and its thinking: a
 * ceiling at or past the engine's context means it overflows first.
 */
export const LOCAL_CEILING_SHARE = 0.8;

/** The compact ceiling for a local model with `contextTokens`, never raised. */
export function ceilingForLocalContext(ceiling: number, contextTokens: number): number {
  if (!(contextTokens > 0)) return ceiling;
  return Math.min(ceiling, Math.floor(contextTokens * LOCAL_CEILING_SHARE));
}

export type HomeSettings = {
  model: string;
  turnTimeoutSec: number;
  reasoning: string;
  hygieneN: number;
  compactCeilingTokens: number;
  compactSeedPercent: number;
  playTranscriptTailRows: number;
  /** Output cap per Game Master call (llama.cpp-family models, hosted book). */
  maxTokens: number;
  searchFullModel: string;
  searchFullReasoning: string;
  gmVoicePath: string;
  gmPersonality: string;
  localThinkingOpener: string;
  localContextTokens: number;
  localReasoningTokens: number;
  localCacheK: string;
  localCacheV: string;
  localTuning: LocalTuning;
  localKvOffload: boolean;
  localFlashAttention: boolean;
  /** unset lets the engine use every card its build sees */
  localGpu?: LocalGpuChoice;
  debug: boolean;
  logPath: string;
  servePort: number;
};

export function homeSettingsFromConfig(config: NqConfig): HomeSettings {
  return {
    model: config.model ?? "",
    turnTimeoutSec: config.turnTimeoutMs / 1000,
    reasoning: config.reasoning,
    hygieneN: config.hygieneN,
    compactCeilingTokens: config.compactCeilingTokens,
    compactSeedPercent: config.compactSeedPercent,
    playTranscriptTailRows: config.playTranscriptTailRows,
    maxTokens: config.maxTokens,
    searchFullModel: config.searchFullModel ?? "",
    searchFullReasoning: config.searchFullReasoning ?? "",
    gmVoicePath: config.gmVoicePath ?? "",
    gmPersonality: config.gmPersonality ?? "",
    localThinkingOpener: config.localThinkingOpener ?? "",
    localContextTokens: config.localContextTokens,
    localReasoningTokens: config.localReasoningTokens,
    localCacheK: config.localCacheK,
    localCacheV: config.localCacheV,
    localTuning: config.localTuning,
    localKvOffload: config.localKvOffload,
    localFlashAttention: config.localFlashAttention,
    ...(config.localGpu ? { localGpu: config.localGpu } : {}),
    debug: config.debug,
    logPath: config.logPath ?? "",
    servePort: config.servePort,
  };
}

export function parseHomeSettings(value: unknown): HomeSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Settings must be an object.");
  }
  const record = value as Record<string, unknown>;
  const settings: HomeSettings = {
    model: stringValue(record, "model"),
    turnTimeoutSec: numberValue(record, "turnTimeoutSec", 1, 86_400),
    reasoning: stringValue(record, "reasoning"),
    hygieneN: integerValue(record, "hygieneN", 1, 10_000),
    compactCeilingTokens: integerValue(
      record,
      "compactCeilingTokens",
      4_096,
      10_000_000,
    ),
    compactSeedPercent: integerValue(record, "compactSeedPercent", 1, 100),
    playTranscriptTailRows: integerValue(
      record,
      "playTranscriptTailRows",
      0,
      100_000,
    ),
    maxTokens: integerValue(record, "maxTokens", 256, 1_000_000),
    searchFullModel: stringValue(record, "searchFullModel"),
    searchFullReasoning: stringValue(record, "searchFullReasoning"),
    gmVoicePath: stringValue(record, "gmVoicePath"),
    gmPersonality: stringValue(record, "gmPersonality"),
    localThinkingOpener: stringValue(record, "localThinkingOpener"),
    localContextTokens: integerValue(
      record,
      "localContextTokens",
      1,
      10_000_000,
    ),
    localReasoningTokens: integerValue(
      record,
      "localReasoningTokens",
      -1,
      10_000_000,
    ),
    localCacheK: cacheTypeValue(record, "localCacheK"),
    localCacheV: cacheTypeValue(record, "localCacheV"),
    // out-of-range knobs are dropped rather than rejected: they only ever
    // narrow the engine's own defaults back in
    localTuning: parseLocalTuning(
      record.localTuning as Record<string, unknown> | undefined,
    ),
    localKvOffload: record.localKvOffload !== false,
    localFlashAttention: record.localFlashAttention !== false,
    ...(parseLocalGpuChoice(record.localGpu)
      ? { localGpu: parseLocalGpuChoice(record.localGpu)! }
      : {}),
    debug: booleanValue(record, "debug"),
    logPath: stringValue(record, "logPath"),
    servePort: integerValue(record, "servePort", 1, 65_535),
  };
  if (!settings.reasoning) throw new Error("Reasoning is required.");
  return settings;
}

export function applyHomeSettings(
  config: NqConfig,
  settings: HomeSettings,
): void {
  config.model = settings.model.trim() || undefined;
  config.turnTimeoutMs = settings.turnTimeoutSec * 1000;
  config.reasoning = settings.reasoning;
  config.hygieneN = settings.hygieneN;
  config.compactCeilingTokens = settings.compactCeilingTokens;
  config.compactSeedPercent = settings.compactSeedPercent;
  config.playTranscriptTailRows = settings.playTranscriptTailRows;
  config.maxTokens = settings.maxTokens;
  config.searchFullModel = settings.searchFullModel.trim() || undefined;
  config.searchFullReasoning = settings.searchFullReasoning.trim() || undefined;
  config.gmVoicePath = settings.gmVoicePath.trim() || undefined;
  config.gmPersonality = settings.gmPersonality.trim() || undefined;
  config.localThinkingOpener = settings.localThinkingOpener.trim() || undefined;
  config.localContextTokens = settings.localContextTokens;
  config.localReasoningTokens = settings.localReasoningTokens;
  config.localCacheK = settings.localCacheK as typeof config.localCacheK;
  config.localCacheV = settings.localCacheV as typeof config.localCacheV;
  config.localTuning = settings.localTuning;
  config.localKvOffload = settings.localKvOffload;
  config.localFlashAttention = settings.localFlashAttention;
  config.localGpu = settings.localGpu;
  config.debug = settings.debug;
  config.logPath = settings.logPath.trim() || undefined;
  config.servePort = settings.servePort;
}

export async function saveHomeSettings(
  configPath: string,
  settings: HomeSettings,
): Promise<void> {
  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    // A config file is created on the first saved setting.
  }

  const desired: DesiredToml = {
    "": {
      model: tomlOptional(settings.model),
      timeout: tomlNumber(settings.turnTimeoutSec),
      max_tokens: tomlNumber(settings.maxTokens),
      reasoning: tomlString(settings.reasoning),
      gm_voice: tomlOptional(settings.gmVoicePath),
      debug: String(settings.debug),
      log: tomlOptional(settings.logPath),
    },
    hygiene: {
      n: tomlNumber(settings.hygieneN),
    },
    compact: {
      ceiling: tomlNumber(settings.compactCeilingTokens),
      seed_percent: tomlNumber(settings.compactSeedPercent),
      keep_tail_percent: null,
      keep_tail: null,
    },
    play: {
      transcript_tail: tomlNumber(settings.playTranscriptTailRows),
      gm_personality: tomlOptional(settings.gmPersonality),
      reasoning: null,
      gm_voice: null,
    },
    search_full: {
      model: tomlOptional(settings.searchFullModel),
      reasoning: tomlOptional(settings.searchFullReasoning),
    },
    local: {
      context_tokens: tomlNumber(settings.localContextTokens),
      reasoning_tokens: tomlNumber(settings.localReasoningTokens),
      cache_k: settings.localCacheK,
      cache_v: settings.localCacheV,
      kv_offload: settings.localKvOffload ? null : "false",
      flash_attention: settings.localFlashAttention ? null : "false",
      gpu_backend: settings.localGpu ? tomlString(settings.localGpu.backend) : null,
      gpu_device: settings.localGpu ? tomlString(settings.localGpu.device) : null,
      gpu_name: settings.localGpu ? tomlString(settings.localGpu.name) : null,
      // a knob left at Atomic's default is removed rather than written out,
      // so the file records choices instead of restating the engine
      ...Object.fromEntries(
        LOCAL_TUNING_FIELDS.map((field) => {
          const value = settings.localTuning[field.key];
          return [field.config, value === undefined ? null : tomlNumber(value)];
        }),
      ),
      thinking_opener: tomlOptional(settings.localThinkingOpener),
    },
    serve: {
      port: tomlNumber(settings.servePort),
    },
  };

  const next = patchToml(raw, desired);
  await mkdir(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(tempPath, next, "utf8");
  await rename(tempPath, configPath);
}

function patchToml(raw: string, desired: DesiredToml): string {
  const sections = splitSections(raw);
  for (const [name, values] of Object.entries(desired)) {
    let section = sections.find((candidate) => candidate.name === name);
    if (!section) {
      section = { name, header: name ? `[${name}]` : "", lines: [] };
      sections.push(section);
    }
    section.lines = patchSection(section.lines, values);
  }

  const out: string[] = [];
  for (const section of sections) {
    if (section.header) {
      if (out.length > 0 && out.at(-1) !== "") out.push("");
      out.push(section.header);
    }
    out.push(...section.lines);
  }
  while (out.at(-1) === "") out.pop();
  return `${out.join("\n")}\n`;
}

function splitSections(raw: string): TomlSection[] {
  const sections: TomlSection[] = [{ name: "", header: "", lines: [] }];
  let current = sections[0]!;
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (match) {
      current = { name: match[1]!.trim(), header: line, lines: [] };
      sections.push(current);
    } else {
      current.lines.push(line);
    }
  }
  return sections;
}

function patchSection(
  lines: string[],
  values: Record<string, string | null>,
): string[] {
  const remaining = new Map(Object.entries(values));
  const out: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    const key = match?.[1];
    if (!key || !Object.hasOwn(values, key)) {
      out.push(line);
      continue;
    }
    if (!remaining.has(key)) continue;
    const next = remaining.get(key);
    remaining.delete(key);
    if (next !== null) out.push(`${key} = ${next}`);
  }
  while (out.at(-1) === "") out.pop();
  for (const [key, value] of remaining) {
    if (value !== null) out.push(`${key} = ${value}`);
  }
  return out;
}

type TomlSection = { name: string; header: string; lines: string[] };
type DesiredToml = Record<string, Record<string, string | null>>;

function tomlOptional(value: string): string | null {
  const next = value.trim();
  return next ? tomlString(next) : null;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlNumber(value: number): string {
  return String(value);
}

function stringValue(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`${key} must be text.`);
  return field.trim();
}

function booleanValue(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean")
    throw new Error(`${key} must be true or false.`);
  return field;
}

function cacheTypeValue(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (
    typeof field !== "string" ||
    !(LOCAL_CACHE_TYPES as readonly string[]).includes(field)
  ) {
    throw new Error(`${key} must be one of ${LOCAL_CACHE_TYPES.join(", ")}.`);
  }
  return field;
}

function numberValue(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const field = value[key];
  if (
    typeof field !== "number" ||
    !Number.isFinite(field) ||
    field < min ||
    field > max
  ) {
    throw new Error(`${key} must be between ${min} and ${max}.`);
  }
  return field;
}

function integerValue(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const field = numberValue(value, key, min, max);
  if (!Number.isInteger(field))
    throw new Error(`${key} must be a whole number.`);
  return field;
}
