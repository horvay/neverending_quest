import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "./fs_util.ts";
import { SCRATCH_JSONL } from "./paths.ts";
import type { ScratchRecord, ScratchTool } from "./types.ts";

export async function appendScratchRecord(
  campaignPath: string,
  record: ScratchRecord,
): Promise<ScratchRecord> {
  const abs = path.join(campaignPath, SCRATCH_JSONL);
  await mkdir(path.dirname(abs), { recursive: true });
  await appendFile(abs, `${JSON.stringify(record)}\n`);
  return record;
}

export async function readScratch(
  campaignPath: string,
): Promise<ScratchRecord[]> {
  const abs = path.join(campaignPath, SCRATCH_JSONL);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  if (raw.trim().length === 0) return [];
  const rows: ScratchRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.ts === "string" &&
      typeof obj.turn === "number" &&
      typeof obj.thinking === "string" &&
      Array.isArray(obj.tools)
    ) {
      rows.push({
        ts: obj.ts,
        turn: obj.turn,
        thinking: obj.thinking,
        tools: obj.tools.filter(isScratchTool),
      });
    }
  }
  return rows;
}

export async function writeScratch(
  campaignPath: string,
  records: ScratchRecord[],
): Promise<void> {
  const abs = path.join(campaignPath, SCRATCH_JSONL);
  await mkdir(path.dirname(abs), { recursive: true });
  const body = records.map((row) => `${JSON.stringify(row)}\n`).join("");
  await writeFile(abs, body);
}

export async function upsertScratchRecord(
  campaignPath: string,
  record: ScratchRecord,
): Promise<ScratchRecord> {
  const rows = await readScratch(campaignPath);
  const idx = rows.findIndex((row) => row.ts === record.ts);
  if (idx >= 0) rows[idx] = record;
  else rows.push(record);
  await writeScratch(campaignPath, rows);
  return record;
}

export async function pruneScratchByTs(
  campaignPath: string,
  timestamps: Iterable<string>,
): Promise<ScratchRecord[]> {
  const drop = new Set(timestamps);
  if (drop.size === 0) return readScratch(campaignPath);
  const rows = await readScratch(campaignPath);
  const kept = rows.filter((row) => !drop.has(row.ts));
  if (kept.length === rows.length) return rows;
  await writeScratch(campaignPath, kept);
  return kept;
}

function isScratchTool(value: unknown): value is ScratchTool {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string") return false;
  if (obj.path !== undefined && typeof obj.path !== "string") return false;
  if (obj.wrote !== undefined && typeof obj.wrote !== "boolean") return false;
  if (obj.n !== undefined && (!Number.isInteger(obj.n) || (obj.n as number) < 1)) {
    return false;
  }
  if (
    obj.value !== undefined &&
    (!Number.isInteger(obj.value) || (obj.value as number) < 1)
  ) {
    return false;
  }
  if (obj.reason !== undefined && typeof obj.reason !== "string") return false;
  if (obj.query !== undefined && typeof obj.query !== "string") return false;
  return true;
}
