import type { ScratchTool } from "../../../../campaign/types.ts";
import type { LocalLogChunk, LocalLogSource } from "@nq/local-inference/logs.ts";
import type { KernelState } from "../../../../play/kernel.ts";

export type InspectView = {
  target: string;
  text: string;
  hash?: string;
  slug?: string;
  stale?: boolean;
  error?: string;
  entries?: Array<{
    slug: string;
    name?: string;
    aliases?: string[];
    personality?: string;
    body?: string;
    archived?: boolean;
  }>;
  archived?: boolean;
};

export type ScratchView = {
  ts: string;
  turn: number;
  thinking: string;
  tools: ScratchTool[];
};

export type HistoryEntry = {
  turn: number;
  prose: string;
};

export type IllustratingView = {
  prompt?: string;
  src?: string;
  ts?: string;
  scratch?: { thinking: string; tools: ScratchTool[] };
  candidates?: Array<string | undefined>;
};

export type BookAppProps = {
  state: KernelState;
  inspect: InspectView;
  campaignName?: string;
  scratch?: ScratchView[];
  history?: HistoryEntry[];
  onSubmit: (text: string) => unknown;
  onInterrupt: () => void;
  onInspect: (target: string, slug?: string) => void;
  onSaveInspect?: (text: string) => unknown;
  onCreateDossier?: (slug: string) => unknown;
  onArchiveDossier?: (slug: string, archive: boolean) => unknown;
  onHygiene?: (mode: "light" | "heavy" | "compact" | "fresh") => unknown;
  onLuck?: (armed: boolean) => unknown;
  onEditTranscript?: (ts: string, text: string) => unknown;
  onDeleteTranscript?: (ts?: string) => unknown;
  /** With `thinking`, the Game Master's reasoning continues from that text. */
  onRetryTranscript?: (ts: string, thinking?: string) => unknown;
  onContinue?: (turn: number) => unknown;
  onLeave?: () => void;
  /** Local Atomic can end the active reasoning block without aborting the Turn. */
  canEndReasoning?: boolean;
  /** A llama.cpp Game Master can think on from the player's edit of its Scratch. */
  canEditScratch?: boolean;
  onEndReasoning?: () => Promise<boolean>;
  /** The player is typing; a scale-to-zero Game Master can start waking. */
  onComposeInput?: () => void;
  onReadLocalLog?: (
    source: LocalLogSource,
    offset?: number,
    file?: string,
  ) => Promise<LocalLogChunk>;
  /** Locks compose / inspect / brush while a player write is in flight. */
  authoring?: boolean;
  /** Hide the brush when the local runner is absent. */
  illustrationReady?: boolean;
  onIllustrate?: (prompt?: string) => unknown;
  /** Cache-bust the PNG after a replace. */
  illustrateTick?: number;
  /** Full-page easel while a sitting is being painted or just finished. */
  illustrating?: IllustratingView | null;
  /** Rewrite tags remembered for a sitting, keyed by GM row ts. */
  sittingPrompts?: Record<string, string>;
  /** Dismiss the painting easel (Leave it / Escape). */
  onDismissEasel?: () => void;
  onPickIllustration?: (slot: number) => unknown;
  /** Optional desk error string. */
  notice?: string;
  /** Settings that may change while this Campaign is open (from Home). */
  playSettings?: PlaySettingsView;
  /** Setting keys the player cannot change here; their fields are hidden. */
  fixedSettings?: string[];
  /** Save changed play settings; resolves to an error message, or null. */
  onSavePlaySettings?: (settings: PlaySettingsView) => Promise<string | null>;
};

/** The settings the book can change mid-Campaign; Home's settings carry them. */
export type PlaySettingsView = {
  turnTimeoutSec: number;
  hygieneN: number;
  compactCeilingTokens: number;
  compactSeedPercent: number;
  playTranscriptTailRows: number;
  maxTokens: number;
  gmPersonality: string;
  debug: boolean;
  logPath: string;
};
