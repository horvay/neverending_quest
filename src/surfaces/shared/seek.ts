/** Seek on the Inspect leaves: rank Dossiers and filter beats by a phrase. */

function leafQueryHit(hay: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return hay.toLowerCase().includes(needle);
}

function dossierTitleHay(entry: {
  slug: string;
  name?: string;
  aliases?: string[];
}): string {
  return [entry.name ?? "", entry.slug, ...(entry.aliases ?? [])].join("\n");
}

export function rankDossierHits<
  T extends {
    slug: string;
    name?: string;
    aliases?: string[];
    personality?: string;
    body?: string;
  },
>(entries: T[], query: string): Array<T & { via: "title" | "body" | "all" }> {
  if (!query.trim()) {
    return entries.map((e) => ({ ...e, via: "all" as const }));
  }
  const titled: Array<T & { via: "title" }> = [];
  const bodied: Array<T & { via: "body" }> = [];
  for (const e of entries) {
    if (leafQueryHit(dossierTitleHay(e), query)) {
      titled.push({ ...e, via: "title" });
    } else if (leafQueryHit(dossierBodyHay(e), query)) {
      bodied.push({ ...e, via: "body" });
    }
  }
  return [...titled, ...bodied];
}

function dossierBodyHay(entry: { personality?: string; body?: string }): string {
  return [entry.personality ?? "", entry.body ?? ""].join("\n");
}

export function dossierExcerpt(
  entry: { personality?: string; body?: string },
  query: string,
): string {
  const body = dossierBodyHay(entry);
  if (!body.trim() || !query.trim()) return "";
  const line = body.split("\n").find((row) => {
    const t = row.trim();
    return t.length > 0 && !t.startsWith("---") && leafQueryHit(t, query);
  });
  if (!line) return "";
  const clipped = line.trim().replace(/^[-*#>\s]+/, "");
  return clipped.length > 88 ? `${clipped.slice(0, 87)}…` : clipped;
}

export function filterBeatsText(text: string, query: string): string {
  if (!query.trim()) return text;
  return text
    .split("\n")
    .filter((line) => leafQueryHit(line, query))
    .join("\n");
}

