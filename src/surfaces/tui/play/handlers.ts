import type { LocalLogChunk, LocalLogSource } from "@nq/local-inference/logs.ts";
import type { ScratchRecord } from "../../../campaign/types.ts";
import type { InspectLeaf, ManualHygieneMode } from "../../../play/types.ts";

/** What Home says about play from inside a Campaign. */
export type PlayHomeView = {
  /** Mid-Campaign play settings as saved (all keys; `fixed` ones are not the player's). */
  settings: Record<string, unknown>;
  fixed: readonly string[];
  diagnostics: boolean;
  /** The Game Master's model selector. */
  model: string;
};

/**
 * Everything the terminal play chrome asks of the Campaign, Home and the
 * machine. `run.ts` wires these to a PlaySession and a HomeSurface; a
 * refused command rejects with the CampaignError (or HomeError) itself.
 */
export type TuiChromeHandlers = {
  submit: (text: string) => void;
  interrupt?: () => void;
  quit: () => void;
  editTranscript?: (ts: string, text: string) => Promise<unknown>;
  deleteTranscript?: (ts?: string) => Promise<unknown>;
  retryTranscript?: (ts: string, thinking?: string) => Promise<unknown>;
  continueFromTurn?: (turn: number) => Promise<unknown>;
  endReasoning?: () => Promise<boolean>;
  setLuckArmed?: (armed: boolean) => Promise<unknown>;
  startHygiene?: (mode: ManualHygieneMode) => Promise<unknown>;
  history?: () => Promise<Array<{ turn: number; prose: string }>>;
  scratch?: () => Promise<ScratchRecord[]>;
  inspect?: (target: string, slug?: string) => Promise<InspectLeaf>;
  saveInspect?: (target: string, body: string, hash: string, slug?: string) => Promise<unknown>;
  createDossier?: (slug: string) => Promise<unknown>;
  archiveDossier?: (slug: string, archive: boolean) => Promise<unknown>;
  illustrationStatus?: () => Promise<{ ready: boolean; reason?: string }>;
  illustrate?: (prompt?: string) => Promise<unknown>;
  pickIllustration?: (slot: number) => Promise<unknown>;
  cancelIllustration?: () => Promise<unknown>;
  /** The kept picture of a GM row, or one candidate sitting, as a file. */
  illustrationFile?: (ts: string, slot?: number) => Promise<string>;
  /** Show a picture file in the player's image viewer. */
  openImage?: (path: string) => Promise<void>;
  playHome?: () => Promise<PlayHomeView>;
  savePlaySettings?: (value: Record<string, unknown>) => Promise<void>;
  readLocalLog?: (source: LocalLogSource) => Promise<LocalLogChunk>;
};
