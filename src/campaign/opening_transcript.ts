import { readFile } from "node:fs/promises";
import path from "node:path";
import { SEED_MD } from "./paths.ts";
import { extractOpeningMessage } from "./seed_opening.ts";
import { appendTranscriptRow, readTranscript } from "./transcript.ts";
import type { TranscriptRow } from "./types.ts";

export type OpeningTranscriptResult = {
  /** True when a gm opening row was just written. */
  seeded: boolean;
  /** Full transcript after any seed. */
  rows: TranscriptRow[];
  /** Opening prose when present (just seeded or already on disk). */
  openingText: string | null;
};

/**
 * On a never-played Campaign (empty transcript), copy seed.md's
 * `## Opening message` into transcript.jsonl as the first gm row so
 * `nq play` has story to show before the first player input.
 *
 * Idempotent: never writes when any transcript rows already exist.
 */
export async function ensureOpeningTranscript(
  campaignPath: string,
): Promise<OpeningTranscriptResult> {
  const existing = await readTranscript(campaignPath);
  if (existing.length > 0) {
    const firstGm = existing.find((r) => r.role === "gm");
    return {
      seeded: false,
      rows: existing,
      openingText: firstGm?.text ?? null,
    };
  }

  let seedRaw: string;
  try {
    seedRaw = await readFile(path.join(campaignPath, SEED_MD), "utf8");
  } catch {
    return { seeded: false, rows: existing, openingText: null };
  }

  const opening = extractOpeningMessage(seedRaw);
  if (!opening) {
    return { seeded: false, rows: existing, openingText: null };
  }

  const row = await appendTranscriptRow(campaignPath, {
    role: "gm",
    text: opening,
  });
  return {
    seeded: true,
    rows: [row],
    openingText: opening,
  };
}
