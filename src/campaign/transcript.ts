import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CampaignError } from "./errors.ts";
import { isEnoent } from "./fs_util.ts";

import { TRANSCRIPT_JSONL } from "./paths.ts";
import type { TranscriptRole, TranscriptRow } from "./types.ts";

export async function appendTranscriptRow(
  campaignPath: string,
  row: Omit<TranscriptRow, "ts"> & { ts?: string },
): Promise<TranscriptRow> {
  const full: TranscriptRow = {
    ts: row.ts ?? new Date().toISOString(),
    role: row.role,
    text: row.text,
    ...(typeof row.illustration === "string" && row.illustration
      ? { illustration: row.illustration }
      : {}),
    ...(typeof row.illustrationPrompt === "string" && row.illustrationPrompt
      ? { illustrationPrompt: row.illustrationPrompt }
      : {}),
  };
  const abs = path.join(campaignPath, TRANSCRIPT_JSONL);
  await appendFile(abs, `${JSON.stringify(full)}\n`);
  return full;
}

export async function readTranscript(
  campaignPath: string,
): Promise<TranscriptRow[]> {
  const abs = path.join(campaignPath, TRANSCRIPT_JSONL);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  if (raw.trim().length === 0) return [];
  const rows: TranscriptRow[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.ts === "string" &&
      (obj.role === "player" || obj.role === "gm") &&
      typeof obj.text === "string"
    ) {
      const row: TranscriptRow = {
        ts: obj.ts,
        role: obj.role as TranscriptRole,
        text: obj.text,
      };
      if (typeof obj.illustration === "string" && obj.illustration) {
        row.illustration = obj.illustration;
      }
      if (
        typeof obj.illustrationPrompt === "string" &&
        obj.illustrationPrompt.trim()
      ) {
        row.illustrationPrompt = obj.illustrationPrompt.trim();
      }
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Fingerprint of the story the Game Master has seen: each row's ts, role and
 * text. Illustration stamps are left out, since they never reach the model.
 */
export function transcriptDigest(rows: TranscriptRow[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(`${JSON.stringify([row.ts, row.role, row.text])}\n`);
  }
  return hash.digest("hex");
}

export async function writeTranscript(
  campaignPath: string,
  rows: TranscriptRow[],
): Promise<void> {
  const abs = path.join(campaignPath, TRANSCRIPT_JSONL);
  const body = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  await writeFile(abs, body);
}

/** Stamp or clear the Illustration id and prompt on a row. `ts` / `role` / `text` stay. */
export async function stampTranscriptIllustration(
  campaignPath: string,
  ts: string,
  illustration: string | undefined,
  prompt?: string,
): Promise<TranscriptRow> {
  const rows = await readTranscript(campaignPath);
  const idx = rows.findIndex((row) => row.ts === ts);
  if (idx < 0) {
    throw new CampaignError("not_found", `No transcript row with ts ${ts}`);
  }
  const cur = rows[idx]!;
  const next: TranscriptRow = { ts: cur.ts, role: cur.role, text: cur.text };
  if (illustration) {
    next.illustration = illustration;
    const sitting = prompt?.trim();
    if (sitting) next.illustrationPrompt = sitting;
  }
  rows[idx] = next;
  await writeTranscript(campaignPath, rows);
  return next;
}

/** Surgical text change. `ts` / `role` stay; later rows stay. */
export async function editTranscriptText(
  campaignPath: string,
  ts: string,
  text: string,
): Promise<TranscriptRow> {
  const rows = await readTranscript(campaignPath);
  const idx = rows.findIndex((row) => row.ts === ts);
  if (idx < 0) {
    throw new CampaignError(
      "not_found",
      `No transcript row with ts ${ts}`,
    );
  }
  return writeTranscriptRowAt(campaignPath, rows, idx, text);
}

export async function replaceTranscriptRowAt(
  campaignPath: string,
  index: number,
  text: string,
): Promise<TranscriptRow> {
  const rows = await readTranscript(campaignPath);
  if (index < 0 || index >= rows.length) {
    throw new CampaignError("not_found", `No transcript row at ${index}`);
  }
  return writeTranscriptRowAt(campaignPath, rows, index, text);
}

async function writeTranscriptRowAt(
  campaignPath: string,
  rows: TranscriptRow[],
  index: number,
  text: string,
): Promise<TranscriptRow> {
  const next: TranscriptRow = { ...rows[index]!, text };
  rows[index] = next;
  await writeTranscript(campaignPath, rows);
  return next;
}

/**
 * Last row, or last player+GM pair when the tail is a finished Turn.
 * Mid-log `ts` is refused.
 */
export async function deleteLastTranscript(
  campaignPath: string,
  ts?: string,
): Promise<TranscriptRow[]> {
  const rows = await readTranscript(campaignPath);
  const range = lastDeletableRange(rows);
  if (!range) {
    throw new CampaignError("not_last", "Transcript is empty");
  }
  if (
    ts !== undefined &&
    !range.deleted.some((row) => row.ts === ts)
  ) {
    throw new CampaignError(
      "not_last",
      "Delete last row or last player+GM pair only",
    );
  }
  await writeTranscript(campaignPath, rows.slice(0, range.start));
  return range.deleted;
}

/** Opening GM is turn 0; otherwise the first GM is turn 1. */
export function listGmTurns(
  rows: TranscriptRow[],
): Array<{ turn: number; row: TranscriptRow; index: number }> {
  const out: Array<{ turn: number; row: TranscriptRow; index: number }> = [];
  let turn = rows[0]?.role === "gm" ? 0 : 1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.role !== "gm") continue;
    out.push({ turn, row, index: i });
    turn += 1;
  }
  return out;
}

/** Status / history labels: turn + short GM prose, never a SHA. */
export function shortGmProse(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Reachable Continue targets on the current line (after rewind the list shrinks). */
export function listHistorySnapshots(
  rows: TranscriptRow[],
): Array<{ turn: number; prose: string }> {
  return listGmTurns(rows).map(({ turn, row }) => ({
    turn,
    prose: shortGmProse(row.text),
  }));
}

export function lastDeletableRange(
  rows: TranscriptRow[],
): { start: number; deleted: TranscriptRow[] } | null {
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1]!;
  const prev = rows.length >= 2 ? rows[rows.length - 2] : undefined;
  if (last.role === "gm" && prev?.role === "player") {
    return { start: rows.length - 2, deleted: [prev, last] };
  }
  return { start: rows.length - 1, deleted: [last] };
}

