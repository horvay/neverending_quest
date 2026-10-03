import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { CampaignError } from "./errors.ts";
import { isEnoent } from "./fs_util.ts";

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
import { ensureCampaignGit } from "./history.ts";
import { ensurePlayerSheetH2s } from "./sheet.ts";
import type { CampaignMeta } from "./types.ts";

export type OpenedCampaign = {
  path: string;
  meta: CampaignMeta;
  hasSeed: boolean;
};

/**
 * Resolve path (explicit or cwd) and open a Campaign.
 * Lazy-ensures optional skeleton files without destroying content.
 */
export async function openCampaign(
  explicitPath?: string,
): Promise<OpenedCampaign> {
  const campaignPath = await resolveCampaignPath(explicitPath);
  const meta = await readCampaignMeta(campaignPath);
  await lazyEnsureSkeleton(campaignPath);
  await ensureCampaignGit(campaignPath, "migrate");
  const hasSeed = await fileExists(path.join(campaignPath, SEED_MD));
  return { path: campaignPath, meta, hasSeed };
}

export async function findCampaignPath(
  explicitPath?: string,
): Promise<string | undefined> {
  if (explicitPath !== undefined && explicitPath.length > 0) {
    return path.resolve(explicitPath);
  }
  const cwd = process.cwd();
  if (await fileExists(path.join(cwd, CAMPAIGN_YAML))) {
    return cwd;
  }
  return undefined;
}

export async function resolveCampaignPath(explicitPath?: string): Promise<string> {
  const found = await findCampaignPath(explicitPath);
  if (found) return found;
  throw new CampaignError(
    "path_required",
    "No Campaign path given and cwd has no campaign.yaml",
  );
}

export async function readCampaignMeta(campaignPath: string): Promise<CampaignMeta> {
  const abs = path.join(campaignPath, CAMPAIGN_YAML);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      throw new CampaignError(
        "not_a_campaign",
        `Not a Campaign (missing campaign.yaml): ${campaignPath}`,
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new CampaignError(
      "campaign_yaml_invalid",
      `Unreadable campaign.yaml at ${campaignPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CampaignError(
      "campaign_yaml_invalid",
      `campaign.yaml must be a mapping: ${campaignPath}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const id = obj.id;
  const created_at = obj.created_at;
  const schema_version = obj.schema_version;
  const name = obj.name;
  if (typeof id !== "string" || id.length === 0) {
    throw new CampaignError(
      "campaign_yaml_invalid",
      `campaign.yaml missing id: ${campaignPath}`,
    );
  }
  if (typeof created_at !== "string" || created_at.length === 0) {
    throw new CampaignError(
      "campaign_yaml_invalid",
      `campaign.yaml missing created_at: ${campaignPath}`,
    );
  }
  if (typeof schema_version !== "number") {
    throw new CampaignError(
      "campaign_yaml_invalid",
      `campaign.yaml missing schema_version: ${campaignPath}`,
    );
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new CampaignError(
      "campaign_yaml_invalid",
      `campaign.yaml missing name: ${campaignPath}`,
    );
  }
  return { id, created_at, schema_version, name };
}

export async function lazyEnsureSkeleton(campaignPath: string): Promise<void> {
  await ensureFile(path.join(campaignPath, PLAYER_SHEET_MD), () =>
    ensurePlayerSheetH2s(""),
  );
  await ensureFile(path.join(campaignPath, WORLD_BUILDING_MD), () => "");
  await ensureFile(path.join(campaignPath, STORY_BEATS_MD), () => "");
  await ensureFile(path.join(campaignPath, QUEST_LOG_MD), () => "");
  await ensureFile(path.join(campaignPath, TWISTS_MD), () => "");
  await ensureFile(path.join(campaignPath, TRANSCRIPT_JSONL), () => "");
  await mkdir(path.join(campaignPath, DOSSIERS_DIR), { recursive: true });
  await mkdir(path.join(campaignPath, SESSIONS_DIR), { recursive: true });
}

async function ensureFile(abs: string, factory: () => string): Promise<void> {
  if (await fileExists(abs)) return;
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, factory());
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

