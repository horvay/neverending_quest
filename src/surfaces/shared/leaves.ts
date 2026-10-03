/**
 * Inspect leaves as both Player Surfaces name them: tabs, titles, and what a
 * clean leaf says. Player copy only; the files are the Campaign's.
 */

/** Which leaf is open: a target, and a Dossier slug under `dossiers`. */
type LeafRef = { target: string; slug?: string };

export const TABS = [
  "quests",
  "twists",
  "beats",
  "sheet",
  "world",
  "dossiers",
  "status",
  "settings",
] as const;

export const TAB_LABEL: Record<(typeof TABS)[number], string> = {
  quests: "Quests",
  twists: "Twists",
  beats: "Beats",
  sheet: "Sheet",
  world: "World",
  dossiers: "Dossiers",
  status: "Status",
  settings: "Settings",
};

export const SKELETON_FILES = [
  "seed",
  "sheet",
  "world",
  "dossiers",
  "beats",
  "quests",
  "twists",
] as const;

export const LEAF_NAME: Record<(typeof SKELETON_FILES)[number], string> = {
  seed: "the seed",
  sheet: "the sheet",
  world: "the world",
  dossiers: "the dossiers",
  beats: "the beats",
  quests: "the quest log",
  twists: "the twists",
};

export const BLANK_REASON: Record<string, string> = {
  quests:
    "No charges are open. The Game Master will write them as the story demands — or you may set the first charge yourself.",
  beats:
    "The beat log has no entries. After a few turns, catch the book up from Status — or begin the first beat here.",
  twists:
    "No turns are planned yet. The Game Master sets them down as the story gives it something to twist — or plant the first one yourself.",
  sheet: "The player sheet has no ink yet. Write who you are, or wait for the Game Master to set it down.",
  world: "The world leaf is still clean. Places will gather here as they are named — or begin the map yourself.",
  dossiers: "No names are entered yet. People will appear here as they are met — or write one now.",
  seed: "The seed is blank. Write the premise the Game Master should play from.",
};

export const LEAF_TITLE: Record<string, { title: string; kicker: string }> = {
  quests: { title: "Quest Log", kicker: "Open leads" },
  twists: { title: "Twists", kicker: "What the Game Master holds back" },
  beats: { title: "Story Beats", kicker: "The chronicle so far" },
  sheet: { title: "Player Sheet", kicker: "Who you are" },
  world: { title: "World", kicker: "Setting, factions, and lore" },
  seed: { title: "Seed", kicker: "The premise of play" },
  dossiers: { title: "Dossiers", kicker: "Dramatis personae" },
  status: { title: "Status", kicker: "The book at a glance" },
  settings: { title: "Settings", kicker: "How this book reads and plays" },
};

/** Leaves reached through the World tab's links. */
export const WORLD_LEAVES = [
  { target: "world", label: "World info" },
  { target: "seed", label: "Seed" },
] as const;

const WRITABLE = new Set([
  "sheet",
  "world",
  "seed",
  "beats",
  "quests",
  "twists",
  "dossiers",
]);

const MANUSCRIPT = new Set(["sheet", "world", "seed", "dossiers"]);

export function inspectWritable(inspect: LeafRef): boolean {
  if (!WRITABLE.has(inspect.target)) return false;
  if (inspect.target === "dossiers" && !inspect.slug) return false;
  return true;
}

export function inspectManuscript(inspect: LeafRef): boolean {
  return MANUSCRIPT.has(inspect.target);
}

export function inspectHasInk(text: string): boolean {
  return text.trim().length > 0;
}
