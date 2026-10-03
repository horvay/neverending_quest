import { PLAYER_SHEET_H2S } from "./paths.ts";

/**
 * Ensure required Player Sheet H2s exist. Missing headings are appended;
 * existing body is kept verbatim.
 */
export function ensurePlayerSheetH2s(body: string): string {
  const text = body.replace(/\s+$/, "");
  const missing = PLAYER_SHEET_H2S.filter((h2) => !hasH2(text, h2));
  if (missing.length === 0) {
    return body.endsWith("\n") || body.length === 0 ? body : `${body}\n`;
  }
  const additions = missing.map((h2) => `## ${h2}\n`).join("\n");
  if (text.length === 0) {
    return `${additions}\n`;
  }
  return `${text}\n\n${additions}\n`;
}

function hasH2(text: string, heading: string): boolean {
  const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m");
  return re.test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
