import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseTomlish } from "./toml_lite.ts";
import {
  DEFAULT_LOCAL_CONTEXT_TOKENS,
  DEFAULT_LOCAL_CACHE_K,
  DEFAULT_LOCAL_CACHE_V,
  DEFAULT_LOCAL_REASONING_TOKENS,
  LOCAL_CACHE_TYPES,
  parseLocalGpuChoice,
  type LocalCacheType,
  type LocalGpuChoice,
} from "@nq/local-inference/profile.ts";
import {
  dropSavedFullProfile,
  parseLocalTuning,
  type LocalTuning,
} from "@nq/local-inference/tuning.ts";
import type { AlmanacEntry } from "@nq/local-inference/almanac.ts";
import { loadAlmanac } from "@nq/local-inference/almanac_store.ts";

function isCacheType(value: unknown): value is LocalCacheType {
  return (
    typeof value === "string" &&
    (LOCAL_CACHE_TYPES as readonly string[]).includes(value)
  );
}
import { DEFAULT_PLAY_CONFIG, type PlayConfig } from "./play/types.ts";
import type { SealedConfig } from "@nq/seal/client.ts";

export { DEFAULT_PLAY_CONFIG };

export const DEFAULT_SERVE_PORT = 7737;
/**
 * The most a llama.cpp-family Game Master may write in one call (thinking,
 * tool calls and reply together), so a model that never stops fails fast
 * instead of filling its whole context.
 */
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_SERVE_HOST = "127.0.0.1";

export type NqConfig = PlayConfig & {
  model?: string;
  /** Output cap per Game Master call on llama.cpp-family models and the hosted book. */
  maxTokens: number;
  localContextTokens: number;
  localReasoningTokens: number;
  localCacheK: LocalCacheType;
  localCacheV: LocalCacheType;
  /** sampling and fit knobs for the local engine; unset knobs use its defaults */
  localTuning: LocalTuning;
  /** false keeps the local KV cache in system RAM instead of on the card */
  localKvOffload: boolean;
  /** false runs the local engine without flash attention, on f16 caches */
  localFlashAttention: boolean;
  /** the one card the local engine runs on; unset uses every card it sees */
  localGpu?: LocalGpuChoice;
  /** The player's own Almanac entries (almanac.json beside the config). */
  almanac: AlmanacEntry[];
  servePort: number;
  /** Bind address for `nq serve`; `0.0.0.0` exposes it on the LAN. */
  serveHost: string;
  /** Remote llama-server reached through the sealed transport, if any. */
  sealed?: SealedConfig;
};

export type { SealedConfig };

export const DEFAULT_SEALED_PORT = 8091;

export class ModelNotConfiguredError extends Error {
  constructor() {
    super(
      "No Game Master model is configured. Run `nq login` or pass `--model <id>`.",
    );
    this.name = "ModelNotConfiguredError";
  }
}

/**
 * Live play must use an NQ-owned model selection rather than OMP's mutable
 * global default role.
 */
export function requireNqModel(config: Pick<NqConfig, "model">): string {
  const model = config.model?.trim();
  if (!model) throw new ModelNotConfiguredError();
  return model;
}

export type GlobalFlags = {
  debug?: boolean;
  logPath?: string;
  timeoutSec?: number;
  model?: string;
  hygieneN?: number;
  compactCeiling?: number;
  compactSeedPercent?: number;
  maxTokens?: number;
  playTranscriptTail?: number;
  searchFullModel?: string;
  searchFullReasoning?: string;
  reasoning?: string;
  gmVoicePath?: string;
  /** play-only */
  tail?: number;
  fullTranscript?: boolean;
  configPath?: string;
  port?: number;
  host?: string;
  openBrowser?: boolean;
};

export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "nq", "config.toml");
}


export async function loadConfigFile(
  configPath: string = defaultConfigPath(),
): Promise<Partial<NqConfig>> {
  const almanac = await loadAlmanac(configPath);
  const withAlmanac = almanac.length > 0 ? { almanac } : {};
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return withAlmanac;
  }
  return { ...parseConfigToml(raw), ...withAlmanac };
}

/** Minimal TOML-ish parser for our flat/nested knobs. */
export function parseConfigToml(raw: string): Partial<NqConfig> {
  const doc = parseTomlish(raw);
  const out: Partial<NqConfig> = {};

  if (typeof doc.debug === "boolean") out.debug = doc.debug;
  if (typeof doc.log === "string") out.logPath = doc.log;
  if (typeof doc.model === "string") out.model = doc.model;
  if (typeof doc.timeout === "number") out.turnTimeoutMs = doc.timeout * 1000;
  if (typeof doc.max_tokens === "number") out.maxTokens = doc.max_tokens;

  const hygiene = asTable(doc.hygiene);
  if (hygiene && typeof hygiene.n === "number") out.hygieneN = hygiene.n;

  const compact = asTable(doc.compact);
  if (compact) {
    if (typeof compact.ceiling === "number")
      out.compactCeilingTokens = compact.ceiling;
    if (typeof compact.seed_percent === "number")
      out.compactSeedPercent = compact.seed_percent;
  }

  const play = asTable(doc.play);
  if (play) {
    if (typeof play.transcript_tail === "number") {
      out.playTranscriptTailRows = play.transcript_tail;
    }
    if (typeof play.gm_voice === "string") out.gmVoicePath = play.gm_voice;
    if (typeof play.gm_personality === "string") {
      out.gmPersonality = play.gm_personality;
    }
    if (typeof play.reasoning === "string") out.reasoning = play.reasoning;
  }
  if (typeof doc.reasoning === "string") out.reasoning = doc.reasoning;
  if (typeof doc.gm_voice === "string") out.gmVoicePath = doc.gm_voice;

  const searchFull = asTable(doc.search_full);
  if (searchFull) {
    if (typeof searchFull.model === "string")
      out.searchFullModel = searchFull.model;
    if (typeof searchFull.reasoning === "string") {
      out.searchFullReasoning = searchFull.reasoning;
    }
  }

  const local = asTable(doc.local);
  if (local) {
    if (typeof local.context_tokens === "number") {
      out.localContextTokens = local.context_tokens;
    }
    if (isCacheType(local.cache_k)) out.localCacheK = local.cache_k;
    if (isCacheType(local.cache_v)) out.localCacheV = local.cache_v;
    out.localTuning = dropSavedFullProfile(
      parseLocalTuning(local, (field) => local[field.config]),
    );
    if (typeof local.kv_offload === "boolean") {
      out.localKvOffload = local.kv_offload;
    }
    if (typeof local.flash_attention === "boolean") {
      out.localFlashAttention = local.flash_attention;
    }
    const gpu = parseLocalGpuChoice({
      backend: local.gpu_backend,
      device: local.gpu_device,
      name: local.gpu_name,
    });
    if (gpu) out.localGpu = gpu;
    if (typeof local.reasoning_tokens === "number") {
      out.localReasoningTokens = local.reasoning_tokens;
    }
    if (typeof local.thinking_opener === "string") {
      out.localThinkingOpener = local.thinking_opener;
    }
  }

  const sealed = asTable(doc.sealed);
  if (
    sealed &&
    typeof sealed.upstream === "string" &&
    typeof sealed.worker_key === "string"
  ) {
    out.sealed = {
      upstream: sealed.upstream,
      workerKey: sealed.worker_key,
      port: typeof sealed.port === "number" ? sealed.port : DEFAULT_SEALED_PORT,
      ...(typeof sealed.api_key === "string" ? { apiKey: sealed.api_key } : {}),
    };
  }

  const serve = asTable(doc.serve);
  if (serve && typeof serve.port === "number") out.servePort = serve.port;
  if (serve && typeof serve.host === "string") out.serveHost = serve.host;

  return out;
}

function asTable(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

export function mergeConfig(
  file: Partial<NqConfig>,
  flags: GlobalFlags,
): NqConfig {
  const base: NqConfig = {
    ...DEFAULT_PLAY_CONFIG,
    maxTokens: DEFAULT_MAX_TOKENS,
    localContextTokens: DEFAULT_LOCAL_CONTEXT_TOKENS,
    localReasoningTokens: DEFAULT_LOCAL_REASONING_TOKENS,
    localCacheK: DEFAULT_LOCAL_CACHE_K,
    localCacheV: DEFAULT_LOCAL_CACHE_V,
    localTuning: {},
    localKvOffload: true,
    localFlashAttention: true,
    almanac: [],
    servePort: DEFAULT_SERVE_PORT,
    serveHost: DEFAULT_SERVE_HOST,
    ...file,
  };
  if (flags.debug !== undefined) base.debug = flags.debug;
  if (flags.logPath !== undefined) base.logPath = flags.logPath;
  if (flags.timeoutSec !== undefined)
    base.turnTimeoutMs = flags.timeoutSec * 1000;
  if (flags.model !== undefined) base.model = flags.model;
  if (flags.hygieneN !== undefined) base.hygieneN = flags.hygieneN;
  if (flags.maxTokens !== undefined) base.maxTokens = flags.maxTokens;
  if (flags.compactCeiling !== undefined) {
    base.compactCeilingTokens = flags.compactCeiling;
  }
  if (flags.compactSeedPercent !== undefined) {
    base.compactSeedPercent = flags.compactSeedPercent;
  }
  if (flags.playTranscriptTail !== undefined) {
    base.playTranscriptTailRows = flags.playTranscriptTail;
  }
  if (flags.tail !== undefined) base.playTranscriptTailRows = flags.tail;
  if (flags.fullTranscript)
    base.playTranscriptTailRows = Number.MAX_SAFE_INTEGER;
  if (flags.searchFullModel !== undefined) {
    base.searchFullModel = flags.searchFullModel;
  }
  if (flags.searchFullReasoning !== undefined) {
    base.searchFullReasoning = flags.searchFullReasoning;
  }
  if (flags.reasoning !== undefined) base.reasoning = flags.reasoning;
  if (flags.gmVoicePath !== undefined) base.gmVoicePath = flags.gmVoicePath;
  if (flags.port !== undefined) base.servePort = flags.port;
  if (flags.host !== undefined) base.serveHost = flags.host;
  return base;
}

export type ParsedArgv = {
  command?: string;
  positionals: string[];
  flags: GlobalFlags;
  /** Remaining command-local raw tokens after global flag strip. */
  rest: string[];
  help: boolean;
};

/**
 * Parse global flags anywhere; first non-flag token is the command.
 */
export function parseArgv(argv: string[]): ParsedArgv {
  const tokens = argv.slice(2);
  const flags: GlobalFlags = {};
  const positionals: string[] = [];
  let help = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--help" || t === "-h") {
      help = true;
      continue;
    }
    if (t === "-d" || t === "--debug") {
      flags.debug = true;
      continue;
    }
    if (t === "--log") {
      flags.logPath = tokens[++i];
      continue;
    }
    if (t === "--timeout") {
      flags.timeoutSec = Number(tokens[++i]);
      continue;
    }
    if (t === "--model") {
      flags.model = tokens[++i];
      continue;
    }
    if (t === "--hygiene-n") {
      flags.hygieneN = Number(tokens[++i]);
      continue;
    }
    if (t === "--max-tokens") {
      flags.maxTokens = Number(tokens[++i]);
      continue;
    }
    if (t === "--compact-ceiling") {
      flags.compactCeiling = Number(tokens[++i]);
      continue;
    }
    if (t === "--compact-seed-percent") {
      flags.compactSeedPercent = Number(tokens[++i]);
      continue;
    }
    if (t === "--tail") {
      flags.tail = Number(tokens[++i]);
      continue;
    }
    if (t === "--full") {
      flags.fullTranscript = true;
      continue;
    }
    if (t === "--gm-voice") {
      flags.gmVoicePath = tokens[++i];
      continue;
    }
    if (t === "--reasoning") {
      flags.reasoning = tokens[++i];
      continue;
    }
    if (t === "--config") {
      flags.configPath = tokens[++i];
      continue;
    }
    if (t === "--port") {
      flags.port = Number(tokens[++i]);
      continue;
    }
    if (t === "--host") {
      flags.host = tokens[++i];
      continue;
    }
    if (t === "--open") {
      flags.openBrowser = true;
      continue;
    }
    if (t.startsWith("-")) {
      // leave unknown flags to command parsers via rest — but we already
      // consumed globals. Put unknown back into positionals stream.
      positionals.push(t);
      continue;
    }
    positionals.push(t);
  }

  const command = positionals[0];
  const rest = positionals.slice(1);
  return { command, positionals: rest, flags, rest, help };
}
