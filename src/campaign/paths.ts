/** Prescribed Campaign folder paths (ADR-0003). */
export const CAMPAIGN_YAML = "campaign.yaml";
export const SEED_MD = "seed.md";
export const PLAYER_SHEET_MD = "player_sheet.md";
export const WORLD_BUILDING_MD = "world-building.md";
export const STORY_BEATS_MD = "story-beats.md";
export const QUEST_LOG_MD = "quest-log.md";
export const TWISTS_MD = "twists.md";
export const TRANSCRIPT_JSONL = "transcript.jsonl";
export const DOSSIERS_DIR = "dossiers";
export const DOSSIERS_ARCHIVE_DIR = "dossiers/archive";
export const NQ_DIR = ".nq";
export const SESSIONS_DIR = ".nq/sessions";
export const PLAY_STATE_JSON = ".nq/play_state.json";
export const SCRATCH_JSONL = ".nq/scratch.jsonl";
export const GITIGNORE = ".gitignore";
export const SESSIONS_IGNORE = ".nq/sessions/";
export const ILLUSTRATIONS_DIR = "illustrations";
export const ILLUSTRATIONS_IGNORE = "illustrations/";

export const SCHEMA_VERSION = 1;

/** Required Player Sheet H2 headings (order preserved when appending). */
export const PLAYER_SHEET_H2S = [
  "Description",
  "Inventory",
  "Powers",
  "Notes",
] as const;

export type PlayerSheetH2 = (typeof PLAYER_SHEET_H2S)[number];
