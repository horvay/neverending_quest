import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { CampaignError } from "./errors.ts";
import { isEnoent } from "./fs_util.ts";

import {
  CAMPAIGN_YAML,
  DOSSIERS_DIR,
  PLAYER_SHEET_MD,
  QUEST_LOG_MD,
  SCHEMA_VERSION,
  SEED_MD,
  SESSIONS_DIR,
  STORY_BEATS_MD,
  TRANSCRIPT_JSONL,
  TWISTS_MD,
  WORLD_BUILDING_MD,
} from "./paths.ts";
import { ensureCampaignGit } from "./history.ts";
import { ensurePlayerSheetH2s } from "./sheet.ts";
import type { CampaignMeta, NewCampaignOptions } from "./types.ts";

const DOSSIER_SLUG_RE = /^[a-z0-9-]+\.md$/;

/**
 * Materialize a Campaign folder from a Seed Pack.
 * Never clobbers a non-empty target. Atomic-enough: validates pack first.
 */
export async function newCampaign(opts: NewCampaignOptions): Promise<CampaignMeta> {
  const campaignPath = path.resolve(opts.path);
  const packDir = path.resolve(opts.packDir);
  const name = opts.name?.trim() || path.basename(campaignPath);
  const now = opts.now ?? (() => new Date());
  const makeId = opts.id ?? (() => crypto.randomUUID());

  await assertPackValid(packDir);
  await assertTargetWritable(campaignPath);

  const seedBody = await readFile(path.join(packDir, SEED_MD), "utf8");
  const sheetBody = ensurePlayerSheetH2s(
    await readFile(path.join(packDir, PLAYER_SHEET_MD), "utf8"),
  );

  let worldBody = "";
  try {
    worldBody = await readFile(path.join(packDir, WORLD_BUILDING_MD), "utf8");
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  let twistsBody = "";
  try {
    twistsBody = await readFile(path.join(packDir, TWISTS_MD), "utf8");
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  const packDossiers = await listPackDossiers(packDir);

  await mkdir(campaignPath, { recursive: true });
  await mkdir(path.join(campaignPath, DOSSIERS_DIR), { recursive: true });
  await mkdir(path.join(campaignPath, SESSIONS_DIR), { recursive: true });

  const meta: CampaignMeta = {
    id: makeId(),
    created_at: now().toISOString(),
    schema_version: SCHEMA_VERSION,
    name,
  };

  try {
    await writeFile(path.join(campaignPath, CAMPAIGN_YAML), stringifyYaml(meta));
    await writeFile(path.join(campaignPath, SEED_MD), ensureTrailingNewline(seedBody));
    await writeFile(path.join(campaignPath, PLAYER_SHEET_MD), sheetBody);
    await writeFile(
      path.join(campaignPath, WORLD_BUILDING_MD),
      ensureTrailingNewline(worldBody),
    );
    await writeFile(path.join(campaignPath, STORY_BEATS_MD), "");
    await writeFile(path.join(campaignPath, QUEST_LOG_MD), "");
    await writeFile(
      path.join(campaignPath, TWISTS_MD),
      ensureTrailingNewline(twistsBody),
    );
    await writeFile(path.join(campaignPath, TRANSCRIPT_JSONL), "");

    for (const file of packDossiers) {
      const body = await readFile(path.join(packDir, DOSSIERS_DIR, file), "utf8");
      await writeFile(
        path.join(campaignPath, DOSSIERS_DIR, file),
        ensureTrailingNewline(body),
      );
    }
    await ensureCampaignGit(campaignPath, "birth");
  } catch (err) {
    // Best-effort: do not leave a half Campaign behind.
    try {
      await rm(campaignPath, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
    throw new CampaignError(
      "write_failed",
      `Failed to write Campaign at ${campaignPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return meta;
}

async function assertPackValid(packDir: string): Promise<void> {
  let st;
  try {
    st = await stat(packDir);
  } catch {
    throw new CampaignError("pack_missing", `Seed Pack not found: ${packDir}`);
  }
  if (!st.isDirectory()) {
    throw new CampaignError("pack_missing", `Seed Pack is not a directory: ${packDir}`);
  }

  const missing: string[] = [];
  for (const req of [SEED_MD, PLAYER_SHEET_MD] as const) {
    try {
      const s = await stat(path.join(packDir, req));
      if (!s.isFile()) missing.push(req);
    } catch {
      missing.push(req);
    }
  }
  if (missing.length > 0) {
    throw new CampaignError(
      "pack_incomplete",
      `Seed Pack missing required file(s): ${missing.join(", ")}`,
    );
  }
}

async function assertTargetWritable(campaignPath: string): Promise<void> {
  let st;
  try {
    st = await stat(campaignPath);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  if (!st.isDirectory()) {
    throw new CampaignError(
      "target_exists",
      `Campaign path exists and is not a directory: ${campaignPath}`,
    );
  }
  const entries = await readdir(campaignPath);
  if (entries.length > 0) {
    throw new CampaignError(
      "target_nonempty",
      `Campaign path is not empty: ${campaignPath}`,
    );
  }
}

async function listPackDossiers(packDir: string): Promise<string[]> {
  const dir = path.join(packDir, DOSSIERS_DIR);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && DOSSIER_SLUG_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

function ensureTrailingNewline(body: string): string {
  if (body.length === 0) return "";
  return body.endsWith("\n") ? body : `${body}\n`;
}

