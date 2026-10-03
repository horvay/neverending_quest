export {
  buildDossierCatalogMarkdown,
  listDossierCatalog,
} from "./catalog.ts";
export {
  archiveDossier,
  dossierRel,
  dossierSlugFromRel,
  parseDossierRel,
  resolveDossierRel,
  slugFromArchiveArg,
  stampAllDossierFrontmatter,
  stampDossierFile,
  type ArchiveDossierResult,
} from "./dossiers.ts";
export {
  dossierFrontmatterMissing,
  ensureDossierFrontmatter,
  parseDossierFrontmatter,
} from "./frontmatter.ts";
export { CampaignError, isCampaignError } from "./errors.ts";
export {
  deleteCampaign,
  type DeleteCampaignInfo,
  type DeleteCampaignOptions,
  type DeleteCampaignResult,
} from "./delete.ts";
export {
  commitCampaign,
  commitParentOid,
  ensureCampaignGit,
  ensureGitignore,
  findFailCommitForTip,
  findPlayCommitForTip,
  findTurnCommit,
  GIT_AUTHOR,
  GIT_BRANCH,
  isCampaignRepo,
  listCampaignHistory,
  listTrackedFiles,
  rewindCampaign,
} from "./history.ts";
export { newCampaign } from "./new.ts";
export {
  findCampaignPath,
  lazyEnsureSkeleton,
  openCampaign,
  readCampaignMeta,
  resolveCampaignPath,
  type OpenedCampaign,
} from "./open.ts";
export {
  CAMPAIGN_YAML,
  DOSSIERS_ARCHIVE_DIR,
  DOSSIERS_DIR,
  NQ_DIR,
  PLAYER_SHEET_H2S,
  PLAYER_SHEET_MD,
  PLAY_STATE_JSON,
  GITIGNORE,
  ILLUSTRATIONS_DIR,
  ILLUSTRATIONS_IGNORE,
  QUEST_LOG_MD,
  SCRATCH_JSONL,
  SCHEMA_VERSION,
  SEED_MD,
  SESSIONS_DIR,
  STORY_BEATS_MD,
  TRANSCRIPT_JSONL,
  TWISTS_MD,
  WORLD_BUILDING_MD,
} from "./paths.ts";
export { defaultPlayState, loadPlayState, savePlayState } from "./play_state.ts";
export { ensurePlayerSheetH2s } from "./sheet.ts";
export {
  showCampaign,
  type ShowResult,
  type ShowTarget,
} from "./show.ts";
export {
  createInspectDossier,
  inspectHash,
  isWritableInspectTarget,
  saveInspectFile,
  type InspectSaveResult,
} from "./inspect.ts";
export { extractOpeningMessage } from "./seed_opening.ts";
export {
  ensureOpeningTranscript,
  type OpeningTranscriptResult,
} from "./opening_transcript.ts";
export {
  appendScratchRecord,
  pruneScratchByTs,
  readScratch,
  upsertScratchRecord,
  writeScratch,
} from "./scratch.ts";
export {
  appendTranscriptRow,
  deleteLastTranscript,
  editTranscriptText,
  lastDeletableRange,
  listGmTurns,
  listHistorySnapshots,
  readTranscript,
  shortGmProse,
  replaceTranscriptRowAt,
  stampTranscriptIllustration,
  transcriptDigest,
  writeTranscript,
} from "./transcript.ts";
export type {
  CampaignMeta,
  DossierCatalogEntry,
  DossierFrontmatter,
  NewCampaignOptions,
  PlayState,
  ScratchRecord,
  ScratchTool,
  TranscriptRole,
  TranscriptRow,
} from "./types.ts";
