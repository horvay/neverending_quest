import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CampaignError } from "./errors.ts";
import {
  dossierFrontmatterMissing,
  ensureDossierFrontmatter,
} from "./frontmatter.ts";
import { isEnoent } from "./fs_util.ts";
import { DOSSIERS_ARCHIVE_DIR, DOSSIERS_DIR } from "./paths.ts";

export const DOSSIER_SLUG_RE = /^[a-z0-9-]+$/;
const DOSSIER_FILE_RE = /^[a-z0-9-]+\.md$/;

export type DossierRel = {
  slug: string;
  archived: boolean;
  rel: string;
};

export type ArchiveDossierResult = {
  slug: string;
  archived: boolean;
  from: string;
  to: string;
  moved: boolean;
};

export function dossierRel(slug: string, archived: boolean): string {
  return archived
    ? `${DOSSIERS_ARCHIVE_DIR}/${slug}.md`
    : `${DOSSIERS_DIR}/${slug}.md`;
}

export function parseDossierRel(rel: string): DossierRel | undefined {
  const posix = rel.split(path.sep).join("/");
  const archived = posix.match(/^dossiers\/archive\/([a-z0-9-]+)\.md$/);
  if (archived?.[1]) {
    return { slug: archived[1], archived: true, rel: posix };
  }
  const live = posix.match(/^dossiers\/([a-z0-9-]+)\.md$/);
  if (live?.[1]) {
    return { slug: live[1], archived: false, rel: posix };
  }
  return undefined;
}

export function dossierSlugFromRel(rel: string): string | undefined {
  return parseDossierRel(rel)?.slug;
}

export function slugFromArchiveArg(raw: string): string | undefined {
  const trimmed = raw.trim();
  const parsed = parseDossierRel(trimmed);
  if (parsed) return parsed.slug;
  if (DOSSIER_SLUG_RE.test(trimmed)) return trimmed;
  return undefined;
}

export async function resolveDossierRel(
  campaignPath: string,
  slug: string,
): Promise<DossierRel | null> {
  if (!DOSSIER_SLUG_RE.test(slug)) return null;
  const live = dossierRel(slug, false);
  const archived = dossierRel(slug, true);
  if (await fileExists(campaignPath, live)) {
    return { slug, archived: false, rel: live };
  }
  if (await fileExists(campaignPath, archived)) {
    return { slug, archived: true, rel: archived };
  }
  return null;
}

export async function archiveDossier(
  campaignPath: string,
  slugRaw: string,
  archive = true,
): Promise<ArchiveDossierResult> {
  const slug = slugFromArchiveArg(slugRaw);
  if (!slug) {
    throw new CampaignError(
      "dossier_slug_invalid",
      `Invalid dossier slug: ${slugRaw}`,
    );
  }
  const found = await resolveDossierRel(campaignPath, slug);
  if (!found) {
    throw new CampaignError("dossier_missing", `No dossier named ${slug}`);
  }
  const destRel = dossierRel(slug, archive);
  if (found.archived === archive) {
    return {
      slug,
      archived: archive,
      from: found.rel,
      to: destRel,
      moved: false,
    };
  }
  const destAbs = path.join(campaignPath, destRel);
  if (await fileExists(campaignPath, destRel)) {
    throw new CampaignError(
      "dossier_exists",
      `Dossier already exists: ${slug}`,
    );
  }
  await mkdir(path.dirname(destAbs), { recursive: true });
  await rename(path.join(campaignPath, found.rel), destAbs);
  return {
    slug,
    archived: archive,
    from: found.rel,
    to: destRel,
    moved: true,
  };
}

export async function stampDossierFile(
  campaignPath: string,
  relOrSlug: string,
): Promise<boolean> {
  const parsed = parseDossierRel(relOrSlug);
  const slug = parsed?.slug ?? relOrSlug;
  if (!DOSSIER_SLUG_RE.test(slug)) return false;
  const rel = parsed?.rel ?? (await resolveDossierRel(campaignPath, slug))?.rel;
  if (!rel) return false;
  const abs = path.join(campaignPath, rel);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
  if (!dossierFrontmatterMissing(raw)) return false;
  const next = ensureDossierFrontmatter(raw, slug);
  if (next === raw) return false;
  await writeFile(abs, next);
  return true;
}

export async function stampAllDossierFrontmatter(
  campaignPath: string,
): Promise<number> {
  let n = 0;
  for (const rel of await listDossierRels(campaignPath)) {
    if (await stampDossierFile(campaignPath, rel)) n += 1;
  }
  return n;
}

export async function listDossierRels(campaignPath: string): Promise<string[]> {
  const live = await listDirMarkdown(campaignPath, DOSSIERS_DIR, false);
  const archived = await listDirMarkdown(
    campaignPath,
    DOSSIERS_ARCHIVE_DIR,
    true,
  );
  return [...live, ...archived];
}

async function listDirMarkdown(
  campaignPath: string,
  dirRel: string,
  archived: boolean,
): Promise<string[]> {
  try {
    const names = await readdir(path.join(campaignPath, dirRel));
    return names
      .filter((n) => DOSSIER_FILE_RE.test(n))
      .sort()
      .map((n) => dossierRel(n.slice(0, -3), archived));
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

async function fileExists(campaignPath: string, rel: string): Promise<boolean> {
  try {
    await readFile(path.join(campaignPath, rel));
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}
