import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listDossierCatalog } from "./catalog.ts";
import { dossierRel, resolveDossierRel } from "./dossiers.ts";
import { CampaignError } from "./errors.ts";
import { isEnoent } from "./fs_util.ts";

import { openCampaign } from "./open.ts";
import {
  CAMPAIGN_YAML,
  DOSSIERS_DIR,
  PLAYER_SHEET_MD,
  QUEST_LOG_MD,
  SEED_MD,
  SESSIONS_DIR,
  STORY_BEATS_MD,
  TRANSCRIPT_JSONL,
  TWISTS_MD,
  WORLD_BUILDING_MD,
} from "./paths.ts";
import { loadPlayState } from "./play_state.ts";
import { readTranscript } from "./transcript.ts";
import type { DossierCatalogEntry } from "./types.ts";

export type ShowTarget =
  | "status"
  | "sheet"
  | "world"
  | "dossiers"
  | "beats"
  | "quests"
  | "twists"
  | "seed"
  | "transcript";

export type ShowResult =
  | { target: "status"; text: string }
  | { target: "sheet"; text: string }
  | { target: "world"; text: string }
  | { target: "beats"; text: string }
  | { target: "quests"; text: string }
  | { target: "twists"; text: string }
  | { target: "seed"; text: string }
  | { target: "transcript"; text: string }
  | {
      target: "dossiers";
      text: string;
      entries?: DossierCatalogEntry[];
      slug?: string;
      archived?: boolean;
    };

const SHOW_TARGETS = new Set<string>([
  "status",
  "sheet",
  "world",
  "dossiers",
  "beats",
  "quests",
  "twists",
  "seed",
  "transcript",
]);

export async function showCampaign(opts: {
  path?: string;
  target?: string;
  dossierSlug?: string;
}): Promise<ShowResult> {
  const opened = await openCampaign(opts.path);
  const targetRaw = opts.target ?? "status";
  const target = targetRaw === "dossiers" ? "dossiers" : targetRaw;

  if (target !== "dossiers" && !SHOW_TARGETS.has(target)) {
    throw new CampaignError(
      "show_target_unknown",
      `Unknown show target: ${targetRaw}`,
    );
  }

  switch (target) {
    case "status":
      return { target: "status", text: await formatStatus(opened.path, opened.meta) };
    case "sheet":
      return {
        target: "sheet",
        text: await readOptional(opened.path, PLAYER_SHEET_MD),
      };
    case "world":
      return {
        target: "world",
        text: await readOptional(opened.path, WORLD_BUILDING_MD),
      };
    case "beats":
      return {
        target: "beats",
        text: await readOptional(opened.path, STORY_BEATS_MD),
      };
    case "quests":
      return {
        target: "quests",
        text: await readOptional(opened.path, QUEST_LOG_MD),
      };
    case "twists":
      return {
        target: "twists",
        text: await readOptional(opened.path, TWISTS_MD),
      };
    case "seed":
      return {
        target: "seed",
        text: await readOptional(opened.path, SEED_MD),
      };
    case "transcript":
      return {
        target: "transcript",
        text: await formatTranscript(opened.path),
      };
    case "dossiers":
      if (opts.dossierSlug) {
        const found = await resolveDossierRel(opened.path, opts.dossierSlug);
        return {
          target: "dossiers",
          text: await readDossierBody(opened.path, opts.dossierSlug),
          slug: opts.dossierSlug,
          archived: found?.archived === true,
        };
      }
      {
        const entries = await listDossierIndex(opened.path);
        return {
          target: "dossiers",
          text: formatDossierIndex(entries),
          entries,
        };
      }
    default:
      throw new CampaignError(
        "show_target_unknown",
        `Unknown show target: ${targetRaw}`,
      );
  }
}

async function formatStatus(
  campaignPath: string,
  meta: { id: string; name: string; created_at: string; schema_version: number },
): Promise<string> {
  const play = await loadPlayState(campaignPath);
  const skeleton = {
    seed: await exists(campaignPath, SEED_MD),
    sheet: await exists(campaignPath, PLAYER_SHEET_MD),
    world: await exists(campaignPath, WORLD_BUILDING_MD),
    dossiers: await exists(campaignPath, DOSSIERS_DIR),
    beats: await exists(campaignPath, STORY_BEATS_MD),
    quests: await exists(campaignPath, QUEST_LOG_MD),
    twists: await exists(campaignPath, TWISTS_MD),
    transcript: await exists(campaignPath, TRANSCRIPT_JSONL),
    sessions: await exists(campaignPath, SESSIONS_DIR),
    campaign_yaml: await exists(campaignPath, CAMPAIGN_YAML),
  };
  const lines = [
    `name: ${meta.name}`,
    `id: ${meta.id}`,
    `created_at: ${meta.created_at}`,
    `schema_version: ${meta.schema_version}`,
    `success_turn_count: ${play.success_turn_count}`,
    `luck_points: ${play.luck_points}`,
    `luck_armed: ${play.luck_armed ? "yes" : "no"}`,
    "skeleton:",
    ...Object.entries(skeleton).map(
      ([k, v]) => `  ${k}: ${v ? "yes" : "no"}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

async function formatTranscript(campaignPath: string): Promise<string> {
  const rows = await readTranscript(campaignPath);
  if (rows.length === 0) return "";
  return `${rows.map((r) => `[${r.role}] ${r.text}`).join("\n")}\n`;
}

async function listDossierIndex(
  campaignPath: string,
): Promise<DossierCatalogEntry[]> {
  return listDossierCatalog(campaignPath, { includeBody: true });
}

function formatDossierIndex(entries: DossierCatalogEntry[]): string {
  if (entries.length === 0) return "(no dossiers)\n";
  const line = (e: DossierCatalogEntry): string => {
    const label = e.name ? `${e.slug} — ${e.name}` : e.slug;
    const kind = e.kind ? ` [${e.kind}]` : "";
    const stub = e.stub_of ? ` (stub of ${e.stub_of})` : "";
    const filed = e.archived ? " (filed)" : "";
    return `${label}${kind}${stub}${filed}`;
  };
  const live = entries.filter((e) => !e.archived);
  const filed = entries.filter((e) => e.archived);
  const blocks = [live.map(line).join("\n")];
  if (filed.length > 0) {
    blocks.push(`Filed:\n${filed.map(line).join("\n")}`);
  }
  return `${blocks.filter(Boolean).join("\n\n")}\n`;
}

async function readDossierBody(
  campaignPath: string,
  slug: string,
): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new CampaignError("dossier_slug_invalid", `Invalid dossier slug: ${slug}`);
  }
  const found = await resolveDossierRel(campaignPath, slug);
  const abs = path.join(
    campaignPath,
    found?.rel ?? dossierRel(slug, false),
  );
  try {
    return await readFile(abs, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      throw new CampaignError(
        "dossier_missing",
        `No dossier named ${slug}`,
      );
    }
    throw err;
  }
}


async function readOptional(campaignPath: string, rel: string): Promise<string> {
  try {
    return await readFile(path.join(campaignPath, rel), "utf8");
  } catch (err) {
    if (isEnoent(err)) return "";
    throw err;
  }
}

async function exists(campaignPath: string, rel: string): Promise<boolean> {
  try {
    await stat(path.join(campaignPath, rel));
    return true;
  } catch {
    return false;
  }
}

