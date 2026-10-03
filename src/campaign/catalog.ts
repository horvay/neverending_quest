import { readFile } from "node:fs/promises";
import path from "node:path";
import { listDossierRels, parseDossierRel } from "./dossiers.ts";
import {
  parseDossierFrontmatter,
  splitDossierDocument,
  type DossierDocumentSplit,
} from "./frontmatter.ts";
import type { DossierCatalogEntry } from "./types.ts";

type DossierCatalogDocument = {
  entry: DossierCatalogEntry;
  rel: string;
  frontmatter: { text: string; endLine: number } | null;
  omittedLineCount: number;
};

/** Internal pseudo-path for the generated, read-only dossier index prompt pin. */
export const GENERATED_DOSSIER_CATALOG_PATH = "dossier-catalog.md";

/**
 * Build synthetic dossier catalog markdown (no bodies) for Context pins.
 * Archived dossiers are omitted — search still finds them.
 */
export async function buildDossierCatalogMarkdown(
  campaignPath: string,
): Promise<string> {
  const documents = (await readDossierCatalogDocuments(campaignPath)).filter(
    ({ entry }) => !entry.archived,
  );
  if (documents.length === 0) {
    return "# Dossier catalog\n\n(no dossiers)\n";
  }
  const lines = ["# Dossier catalog", ""];
  for (const document of documents) {
    const excerpt = document.frontmatter;
    const omitted = omittedLinesNote(document);
    if (excerpt === null) {
      lines.push(`<file path="${document.rel}" />`, omitted, "");
      continue;
    }
    lines.push(
      `<file path="${document.rel}:1-${excerpt.endLine}">`,
      excerpt.text,
      "</file>",
      omitted,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function listDossierCatalog(
  campaignPath: string,
  opts?: { includeBody?: boolean },
): Promise<DossierCatalogEntry[]> {
  const documents = await readDossierCatalogDocuments(
    campaignPath,
    opts?.includeBody,
  );
  return documents.map(({ entry }) => entry);
}

async function readDossierCatalogDocuments(
  campaignPath: string,
  includeBody = false,
): Promise<DossierCatalogDocument[]> {
  const rels = await listDossierRels(campaignPath);
  const documents: DossierCatalogDocument[] = [];
  for (const rel of rels) {
    const parsed = parseDossierRel(rel);
    if (!parsed) continue;
    const raw = await readFile(path.join(campaignPath, rel), "utf8");
    const split = splitDossierDocument(raw);
    const fm = parseDossierFrontmatter(raw);
    const frontmatter = frontmatterExcerpt(raw, split);
    documents.push({
      rel: parsed.rel,
      frontmatter,
      omittedLineCount: countLines(frontmatter === null ? raw : split.body),
      entry: {
        slug: parsed.slug,
        name: fm.name,
        aliases: fm.aliases,
        kind: fm.kind,
        regard: fm.regard,
        personality: fm.personality,
        appearance: fm.appearance,
        stub_of: fm.stub_of,
        archived: parsed.archived || undefined,
        ...(includeBody ? { body: split.body } : {}),
      },
    });
  }
  return documents;
}

function frontmatterExcerpt(
  raw: string,
  split: DossierDocumentSplit,
): DossierCatalogDocument["frontmatter"] {
  if (split.fence === null) return null;
  const text = raw
    .slice(0, raw.length - split.body.length)
    .replace(/\r?\n$/u, "");
  return { text, endLine: text.split(/\r?\n/u).length };
}

function omittedLinesNote(document: DossierCatalogDocument): string {
  const count = document.omittedLineCount;
  if (count === 0) return "[No additional lines in file.]";
  const noun = count === 1 ? "line" : "lines";
  return `[... ${count} more ${noun} in file.]`;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\r?\n$/u, "").split(/\r?\n/u).length;
}
