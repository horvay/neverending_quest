import type { PlayState, ScratchTool } from "../campaign/types.ts";
import type { ShowResult } from "../campaign/show.ts";
import type { Sandbox } from "./sandbox.ts";

export type TurnOutcome = "success" | "fail";

export type FailReason =
  | "empty_prose"
  | "timeout"
  | "interrupt"
  | "agent_error"
  | "busy"
  | "missing_seed"
  | "repetition"
  | "aborted";

export type PlayEvent =
  | { type: "turn_started"; playerText: string; ts?: string; extend?: true }
  | { type: "prose_delta"; text: string }
  | { type: "prose_reset" }
  | {
      type: "turn_ended";
      outcome: TurnOutcome;
      prose?: string;
      reason?: FailReason;
      ts?: string;
      extend?: true;
    }
  | { type: "status"; message: string }
  | { type: "error"; message: string; reason?: FailReason | "git_failed" }
  | { type: "hygiene_started"; mode: "light" | "heavy" }
  | { type: "hygiene_ended"; mode: "light" | "heavy"; ok: boolean; error?: string }
  | { type: "compact_started" }
  | { type: "compact_ended"; ok: boolean; error?: string }
  | { type: "agent_debug"; event: unknown }
  | { type: "roll"; n: number; value: number; reason?: string }
  | { type: "illustrate_started"; ts: string }
  | { type: "illustrate_prompt"; ts: string; prompt: string }
  | { type: "illustrate_candidate"; ts: string; slot: number }
  | { type: "illustrate_ended"; ts?: string; ok: boolean }
  | { type: "illustrate_picked"; ts: string; slot: number }
  | { type: "illustrate_cancelled"; ts?: string }
  | { type: "scratch_live"; thinking: string; tools: ScratchTool[] }
  | { type: "context"; used: number; ceiling: number }
  | {
      type: "story_replaced";
      story: Array<{
        role: "player" | "gm";
        text: string;
        ts?: string;
        turn?: number;
        illustration?: string;
        illustrationPrompt?: string;
      }>;
      successTurnCount: number;
      /** Keep chrome locked (Continue rewind still in flight). */
      busy?: true;
    };

export type ManualHygieneMode = "light" | "heavy" | "compact" | "fresh";

export type PlayLoopState =
  | "idle"
  | "turning"
  | "hygiene"
  | "authoring"
  | "closed";

export type ContextPrime = {
  systemPrompt: string;
  contextFiles: ContextFilePin[];
  /** Estimated tokens of seed+pins; used for overflow checks. */
  estimatedTokens: number;
};

export type ContextFilePin = {
  /** Campaign-relative path. Generated pins use an internal pseudo-path. */
  path: string;
  content: string;
  /** Generated reference context, never a Campaign file. */
  generated?: true;
};

export type SessionCreateOptions = {
  cwd: string;
  sessionsDir: string;
  systemPrompt: string;
  contextFiles: ContextFilePin[];
  /** Tools a prompt may call unless it scopes its own. */
  toolNames: string[];
  /**
   * Tools shown to the model for the session's whole life (defaults to
   * `toolNames`). A prompt scoped to a subset of these keeps the same tool
   * schemas, so the engine's prompt cache survives the pass.
   */
  offeredToolNames?: string[];
  /** Replacement seed: selected dialogue in order, then the system handoff. */
  seedMessages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /** Campaign Sandbox for path jail / custom tools on the live adapter. */
  sandbox?: Sandbox;
  searchFullModel?: string;
  searchFullReasoning?: string;
};

export type AgentPromptResult = {
  /** Final assistant prose (may be empty). */
  prose: string;
  /** True if the run was aborted/cancelled. */
  aborted?: boolean;
  error?: string;
};

export type AgentPromptOptions = {
  signal?: AbortSignal;
  hidden?: boolean;
  /**
   * Prompt-scoped tools the model may call; the session restores its play
   * tools afterward. Names the session offers keep the offered schemas and
   * are enforced when called; any other name swaps the offered schemas.
   */
  toolNames?: readonly string[];
  /**
   * This prompt's thinking prefill in place of the session's opener: the
   * model continues its reasoning from the end of this text. llama.cpp only.
   */
  thinkingOpener?: string;
};

export type AgentSession = {
  readonly id: string;
  prompt(text: string, opts?: AgentPromptOptions): Promise<AgentPromptResult>;
  /** Subscribe to low-level events (prose deltas, tools, etc.). */
  subscribe(handler: (event: AgentSessionEvent) => void): () => void;
  abort(): void;
  end(): Promise<void>;
  /**
   * Current OMP session context occupancy (prompt + pins + tail).
   * Not the model's context window and not a billed-usage total.
   */
  contextTokens?(): number | undefined;
  /**
   * Record in the journal that its conversation is caught up with the
   * transcript whose `transcriptDigest` this is. Only such a journal resumes.
   */
  markTranscriptSync?(digest: string): void;
  /**
   * OMP `/btw` side-channel: same play context, no tools, not a Turn.
   */
  runEphemeralTurn?(opts: {
    promptText: string;
    signal?: AbortSignal;
  }): Promise<AgentPromptResult>;
  /**
   * Illustration rewrite: may read / search Campaign files, must not write,
   * must not become a play Turn or pollute the live Game Master session.
   */
  runLookupTurn?(opts: {
    promptText: string;
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
  }): Promise<AgentPromptResult>;
};

export type AgentSessionEvent =
  | { type: "prose_delta"; text: string }
  | { type: "prose_reset" }
  | { type: "thinking_delta"; text: string; snapshot?: true }
  | {
      type: "tool_call";
      name: string;
      args: unknown;
      toolCallId?: string;
      intent?: string;
    }
  | {
      type: "tool_result";
      name: string;
      result: unknown;
      isError?: boolean;
      toolCallId?: string;
    }
  | { type: "error"; message: string }
  | { type: "debug"; payload: unknown };

export type AgentSessionFactory = {
  create(opts: SessionCreateOptions): Promise<AgentSession>;
  /**
   * Resume the most recent journal with current Context Assembly.
   * The journal keeps conversation history; the prompt and pins come from disk.
   * Null unless that journal was last marked in sync with `transcriptDigest`.
   */
  continueRecent?(
    opts: Pick<
      SessionCreateOptions,
      | "cwd"
      | "sessionsDir"
      | "systemPrompt"
      | "contextFiles"
      | "sandbox"
      | "offeredToolNames"
    > & { transcriptDigest: string },
  ): Promise<AgentSession | null>;
};

/**
 * The part of PlayConfig the player may change while a Campaign is open.
 * Model and local-engine choices are not here: they need a fresh start.
 */
export type LivePlaySettings = Partial<
  Pick<
    PlayConfig,
    | "turnTimeoutMs"
    | "hygieneN"
    | "compactCeilingTokens"
    | "compactSeedPercent"
    | "playTranscriptTailRows"
    | "gmPersonality"
    | "debug"
    | "logPath"
  >
>;

export type PlayConfig = {
  /** Abort only after no streamed model or tool activity for this long. */
  turnTimeoutMs: number;
  /** Total Turn attempts when the Game Master repeats itself; 1 disables retrying. */
  repetitionAttempts: number;
  /** Light Hygiene interval and maximum recent Turns retained after a rebuild. */
  hygieneN: number;
  compactCeilingTokens: number;
  /**
   * Percent of the ceiling a rebuilt session may occupy: system prompt + pins
   * + handoff + transcript tail. Only the tail is clampable — pins are never
   * trimmed — so a Campaign whose pins already exceed this seeds no tail.
   */
  compactSeedPercent: number;
  playTranscriptTailRows: number;
  searchFullModel?: string;
  searchFullReasoning?: string;
  /**
   * Provider thinking effort for play / hygiene on this session.
   * OMP ladder: off | minimal | low | medium | high | xhigh | max | auto.
   */
  reasoning: string;
  /** Override path for the global Game Master voice (prepended to every system prompt). */
  gmVoicePath?: string;
  /** Additional player-authored direction for the Game Master's characterization. */
  gmPersonality?: string;
  /** Local llama.cpp-only reasoning prefix, continued inside the thinking block. */
  localThinkingOpener?: string;
  model?: string;
  debug: boolean;
  logPath?: string;
  /** Token estimator: chars/4 default. */
  estimateTokens?: (text: string) => number;
  /** Context completion reserve subtracted from ceiling for pin overflow. */
  completionReserveTokens: number;
};


export const DEFAULT_PLAY_CONFIG: PlayConfig = {
  turnTimeoutMs: 180_000,
  repetitionAttempts: 3,
  hygieneN: 10,
  compactCeilingTokens: 30_000,
  compactSeedPercent: 50,
  playTranscriptTailRows: 20,
  reasoning: "low",
  debug: false,
  completionReserveTokens: 4096,
};

export type TurnResult = {
  outcome: TurnOutcome;
  prose?: string;
  reason?: FailReason;
  playState: PlayState;
  /** Player pressed Stop; `prose` is the reply as far as it had streamed. */
  stopped?: true;
};

/** One Illustration variant: the picture for `seed` goes to `outPath`. */
export type PaintOneArgs = {
  prompt: string;
  outPath: string;
  seed: number;
  slot: number;
  signal?: AbortSignal;
};

/** Every variant at once, each `seeds[i]` painted to `outPaths[i]`. */
export type PaintBatchArgs = {
  prompt: string;
  seeds: readonly number[];
  outPaths: readonly string[];
  signal: AbortSignal;
  onCandidate: (candidate: { slot: number; seed: number; path: string }) => void;
};

/**
 * What paints Illustrations: one variant at a time (`paintOne`), or all of
 * them around a single GPU handoff (`paintBatch`, preferred when given).
 * Without `status`, an Illustrator that can paint is ready.
 */
export type Illustrator = {
  status?(): Promise<{ ready: boolean; reason?: string }>;
  paintOne?(args: PaintOneArgs): Promise<void>;
  paintBatch?(args: PaintBatchArgs): Promise<void>;
};

/** An Inspect leaf as it is on disk, with the hash a save of it must match. */
export type InspectLeaf = ShowResult & { hash: string };

/** The Campaign files Inspect may show: `nq show` targets but the transcript. */
export const INSPECT_TARGETS: ReadonlySet<string> = new Set([
  "status",
  "sheet",
  "world",
  "beats",
  "quests",
  "twists",
  "seed",
  "dossiers",
]);
