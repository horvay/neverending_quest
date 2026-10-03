import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dossierRel, resolveDossierRel } from "./dossiers.ts";
import { CampaignError } from "./errors.ts";
import {
  ensureDossierFrontmatter,
  parseDossierFrontmatter,
} from "./frontmatter.ts";
import { isEnoent } from "./fs_util.ts";
import { openCampaign } from "./open.ts";
import {
  DOSSIERS_DIR,
  PLAYER_SHEET_MD,
  QUEST_LOG_MD,
  SEED_MD,
  STORY_BEATS_MD,
  TWISTS_MD,
  WORLD_BUILDING_MD,
} from "./paths.ts";

const WRITABLE = new Set([
  "sheet",
  "world",
  "beats",
  "quests",
  "twists",
  "seed",
  "dossiers",
]);
const DOSSIER_SLUG = /^[a-z0-9-]+$/;

export type InspectSaveResult = {
  target: string;
  text: string;
  hash: string;
  slug?: string;
};

export function inspectHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function isWritableInspectTarget(target: string): boolean {
  return WRITABLE.has(target);
}

export async function saveInspectFile(opts: {
  path?: string;
  target: string;
  slug?: string;
  body: string;
  hash: string;
}): Promise<InspectSaveResult> {
  const opened = await openCampaign(opts.path);
  const rel = await inspectRel(opened.path, opts.target, opts.slug);
  const current = await readOptional(opened.path, rel);
  if (opts.target === "dossiers" && current === "" && !(await fileExists(opened.path, rel))) {
    throw new CampaignError("dossier_missing", `No dossier named ${opts.slug}`);
  }
  const currentHash = inspectHash(current);
  if (currentHash !== opts.hash) {
    throw new CampaignError("stale", "Inspect file changed since load", {
      diskText: current,
      diskHash: currentHash,
    });
  }
  const text =
    opts.target === "dossiers" && opts.slug
      ? ensureDossierFrontmatter(opts.body, opts.slug)
      : opts.body;
  await writeFile(path.join(opened.path, rel), text);
  return {
    target: opts.target,
    text,
    hash: inspectHash(text),
    slug: opts.slug,
  };
}

export async function createInspectDossier(opts: {
  path?: string;
  slug: string;
  body?: string;
}): Promise<InspectSaveResult> {
  if (!DOSSIER_SLUG.test(opts.slug)) {
    throw new CampaignError(
      "dossier_slug_invalid",
      `Invalid dossier slug: ${opts.slug}`,
    );
  }
  const opened = await openCampaign(opts.path);
  const existing = await resolveDossierRel(opened.path, opts.slug);
  if (existing) {
    throw new CampaignError(
      "dossier_exists",
      `Dossier already exists: ${opts.slug}`,
    );
  }
  const dir = path.join(opened.path, DOSSIERS_DIR);
  await mkdir(dir, { recursive: true });
  const rel = dossierRel(opts.slug, false);
  const abs = path.join(opened.path, rel);
  const text = scaffoldDossierSections(
    ensureDossierFrontmatter(opts.body ?? "", opts.slug),
  );
  await writeFile(abs, text);
  return {
    target: "dossiers",
    slug: opts.slug,
    text,
    hash: inspectHash(text),
  };
}

function scaffoldDossierSections(text: string): string {
  const frontmatter = parseDossierFrontmatter(text);
  if (frontmatter.stub_of) return text;
  const headings = [
    ...(frontmatter.kind === "person" ? ["Inventory"] : []),
    "Relationships",
    "Abilities",
    "Quirks",
    ...(frontmatter.kind === "place" ? ["Establishment"] : []),
  ];
  const existing = new Set(
    [...text.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((match) =>
      match[1]!.trim().toLowerCase(),
    ),
  );
  const missing = headings.filter((heading) => !existing.has(heading.toLowerCase()));
  if (missing.length === 0) return text;
  return `${text.trimEnd()}\n\n${missing.map((heading) => `## ${heading}`).join("\n\n")}\n`;
}

async function inspectRel(
  campaignPath: string,
  target: string,
  slug?: string,
): Promise<string> {
  if (!WRITABLE.has(target)) {
    throw new CampaignError(
      "inspect_forbidden",
      `Inspect target is not writable: ${target}`,
    );
  }
  switch (target) {
    case "sheet":
      return PLAYER_SHEET_MD;
    case "world":
      return WORLD_BUILDING_MD;
    case "beats":
      return STORY_BEATS_MD;
    case "quests":
      return QUEST_LOG_MD;
    case "twists":
      return TWISTS_MD;
    case "seed":
      return SEED_MD;
    case "dossiers": {
      if (!slug) {
        throw new CampaignError(
          "inspect_forbidden",
          "Dossier save needs a slug",
        );
      }
      if (!DOSSIER_SLUG.test(slug)) {
        throw new CampaignError(
          "dossier_slug_invalid",
          `Invalid dossier slug: ${slug}`,
        );
      }
      const found = await resolveDossierRel(campaignPath, slug);
      return found?.rel ?? dossierRel(slug, false);
    }
    default:
      throw new CampaignError(
        "inspect_forbidden",
        `Inspect target is not writable: ${target}`,
      );
  }
}

async function fileExists(campaignPath: string, rel: string): Promise<boolean> {
  try {
    await stat(path.join(campaignPath, rel));
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
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
