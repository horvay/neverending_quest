import { readFile } from "node:fs/promises";
import path from "node:path";
import { TRANSCRIPT_JSONL } from "../campaign/paths.ts";
import type { Sandbox } from "./sandbox.ts";

export type SearchFullResult = {
  summary: string;
  hits: Array<{ path: string; line: number; text: string }>;
};

/**
 * search_full: deeper recall over memory MD + transcript + seed.
 * POC uses deterministic local search (no second model) so tests and offline
 * play stay network-free. `model`/`reasoning` knobs are accepted for config
 * surface compatibility and reflected in the summary when set; a live
 * subagent swap can consume them later without changing callers.
 */
export async function searchFull(
  sandbox: Sandbox,
  query: string,
  opts?: {
    includeTranscript?: boolean;
    includeSeed?: boolean;
    model?: string;
    reasoning?: string;
  },
): Promise<SearchFullResult> {
  const hits = await sandbox.search(query, {
    includeSeed: opts?.includeSeed ?? true,
  });
  if (opts?.includeTranscript !== false) {
    try {
      const abs = path.join(sandbox.campaignRoot, TRANSCRIPT_JSONL);
      const body = await readFile(abs, "utf8");
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.includes(query)) {
          hits.push({ path: TRANSCRIPT_JSONL, line: i + 1, text: line });
        }
      }
    } catch {
      // no transcript
    }
  }
  let summary =
    hits.length === 0
      ? `No matches for ${JSON.stringify(query)}.`
      : `Found ${hits.length} hit(s) for ${JSON.stringify(query)}.`;
  if (opts?.model) summary += ` [model=${opts.model}]`;
  if (opts?.reasoning) summary += ` [reasoning=${opts.reasoning}]`;
  return { summary, hits };
}
