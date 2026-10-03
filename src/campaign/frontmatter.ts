export type SimpleFrontmatter = {
  name?: string;
  aliases?: string[];
  kind?: string;
  regard?: number;
  personality?: string;
  appearance?: string;
  stub_of?: string;
};

export type DossierDocumentSplit = {
  fence: string | null;
  body: string;
};

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parse optional YAML-ish frontmatter fence for dossier files. */
export function parseDossierFrontmatter(body: string): SimpleFrontmatter {
  const split = splitDossierDocument(body);
  if (split.fence === null) return {};
  const out: SimpleFrontmatter = {};
  for (const line of split.fence.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const raw = trimmed.slice(colon + 1).trim();
    if (key === "name" && raw) out.name = unquote(raw);
    else if (key === "kind" && raw) out.kind = unquote(raw);
    else if (key === "regard" && raw) {
      const regard = Number(unquote(raw));
      if (Number.isInteger(regard) && regard >= 1 && regard <= 10) {
        out.regard = regard;
      }
    } else if (key === "personality") {
      out.personality = raw ? unquote(raw) : "";
    } else if (key === "appearance") {
      out.appearance = raw ? unquote(raw) : "";
    }
    else if (key === "stub_of" && raw) out.stub_of = unquote(raw);
    else if (key === "aliases" && raw.startsWith("[")) {
      out.aliases = raw
        .slice(1, raw.endsWith("]") ? -1 : undefined)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
    }
  }
  return out;
}

export function splitDossierDocument(raw: string): DossierDocumentSplit {
  if (!raw.startsWith("---")) return { fence: null, body: raw };
  const match = FENCE.exec(raw);
  if (!match) return { fence: null, body: raw };
  return { fence: match[1] ?? "", body: raw.slice(match[0].length) };
}

/** Stamp required dossier frontmatter, including neutral regard for people. */
export function ensureDossierFrontmatter(raw: string, slug: string): string {
  const split = splitDossierDocument(raw);
  const parsed = parseDossierFrontmatter(raw);
  const name = parsed.name?.trim() || headingName(split.body) || titleFromSlug(slug);
  const kind = normalizeKind(parsed.kind) ?? "other";
  const aliases = parsed.aliases ?? [];
  const fence = formatDossierFence({
    name,
    aliases,
    kind,
    regard: kind === "person" ? (parsed.regard ?? 5) : undefined,
    personality: parsed.personality?.trim() ?? "",
    appearance: parsed.appearance?.trim() ?? "",
    stub_of: parsed.stub_of,
  });
  const rest = split.body.replace(/^\r?\n+/, "");
  return rest.length > 0 ? `${fence}\n${rest}` : `${fence}\n`;
}

export function dossierFrontmatterMissing(raw: string): boolean {
  const parsed = parseDossierFrontmatter(raw);
  const kind = normalizeKind(parsed.kind);
  return (
    !parsed.name?.trim() ||
    kind === undefined ||
    parsed.aliases === undefined ||
    parsed.personality === undefined ||
    parsed.appearance === undefined ||
    (kind === "person" ? parsed.regard === undefined : hasRegardField(raw))
  );
}

function hasRegardField(raw: string): boolean {
  const fence = splitDossierDocument(raw).fence;
  return fence !== null && /^\s*regard\s*:/m.test(fence);
}

function formatDossierFence(fm: {
  name: string;
  aliases: string[];
  kind: string;
  regard?: number;
  personality?: string;
  appearance?: string;
  stub_of?: string;
}): string {
  const aliases = fm.aliases.map(yamlScalar).join(", ");
  const lines = [
    "---",
    `name: ${yamlScalar(fm.name)}`,
    `aliases: [${aliases}]`,
    `kind: ${fm.kind}`,
  ];
  if (fm.kind === "person") lines.push(`regard: ${fm.regard ?? 5}`);
  lines.push(
    `personality: ${yamlScalar(fm.personality ?? "")}`,
    `appearance: ${yamlScalar(fm.appearance ?? "")}`,
  );
  if (fm.stub_of) lines.push(`stub_of: ${yamlScalar(fm.stub_of)}`);
  lines.push("---");
  return lines.join("\n");
}

function headingName(body: string): string | undefined {
  const line = body.split(/\r?\n/).find((l) => l.trim().length > 0);
  const match = line?.match(/^#\s+(.+)$/);
  const name = match?.[1]?.trim();
  return name || undefined;
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeKind(kind: string | undefined): "person" | "place" | "other" | undefined {
  if (kind === "person" || kind === "place" || kind === "other") return kind;
  return undefined;
}

function yamlScalar(value: string): string {
  if (value.length === 0 || /[:#\[\]{}\n,]/.test(value) || value !== value.trim()) {
    return JSON.stringify(value);
  }
  return value;
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}
