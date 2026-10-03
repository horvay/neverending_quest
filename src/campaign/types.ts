export type CampaignMeta = {
  id: string;
  created_at: string;
  schema_version: number;
  name: string;
};

export type PlayState = {
  success_turn_count: number;
  luck_points: number;
  luck_armed: boolean;
  last_hygiene_success_turn?: number;
  last_hygiene_transcript_line?: number;
  last_hygiene_at?: string;
  last_hygiene_status?: "ok" | "fail";
  last_hygiene_error?: string;
  last_hygiene_mode?: "light" | "heavy";
};

export type TranscriptRole = "player" | "gm";

export type TranscriptRow = {
  ts: string;
  role: TranscriptRole;
  text: string;
  /** GM row `ts` when this row has a player-requested Illustration. */
  illustration?: string;
  /** Anima prompt used to paint that sitting. */
  illustrationPrompt?: string;
};

export type ScratchTool = {
  name: string;
  path?: string;
  wrote?: boolean;
  /** `roll` sides, when the call asked for a die. */
  n?: number;
  /** `roll` result, when the sandbox returned one. */
  value?: number;
  /** Player-facing purpose supplied with a `roll` call. */
  reason?: string;
  /** `search` / `search_full` query, truncated for display. */
  query?: string;
};

export type ScratchRecord = {
  ts: string;
  turn: number;
  thinking: string;
  tools: ScratchTool[];
};

export type DossierFrontmatter = {
  name?: string;
  aliases?: string[];
  kind?: "person" | "place" | "other";
  regard?: number;
  personality?: string;
  appearance?: string;
  stub_of?: string;
};

export type DossierCatalogEntry = {
  slug: string;
  name?: string;
  aliases?: string[];
  kind?: string;
  regard?: number;
  personality?: string;
  appearance?: string;
  stub_of?: string;
  /** True when the file lives under `dossiers/archive/`. */
  archived?: boolean;
  /** Prose after the fence. Inspect search only — not pinned. */
  body?: string;
};

export type NewCampaignOptions = {
  path: string;
  packDir: string;
  name?: string;
  /** Injected for tests. */
  now?: () => Date;
  /** Injected for tests. */
  id?: () => string;
};
