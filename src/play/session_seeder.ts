import { readTranscript } from "../campaign/transcript.ts";
import type { TranscriptRow } from "../campaign/types.ts";
import {
  buildContextPrime,
  buildHistoryHandoff,
  compactHardBudget,
  compactSeedBudget,
  estimateTokensDefault,
  PinOverflowError,
  selectTranscriptTail,
} from "./context.ts";
import type { ContextPrime, PlayConfig, SessionCreateOptions } from "./types.ts";

/**
 * How much transcript a replacement play session carries: `full` replays all
 * of it when it fits the seed budget (and falls back to a compact tail when it
 * does not), `compact` keeps a recent tail, `fresh` keeps none.
 */
export type SeedKind = "full" | "compact" | "fresh";

export type SeedMessage = NonNullable<SessionCreateOptions["seedMessages"]>[number];

/**
 * Context Assembly for a replacement play session: the prime from disk plus
 * the dialogue and handoff to seed it with. No seed at all means a Campaign
 * with an empty transcript. Pins are never trimmed, so pins that alone
 * overflow the hard budget throw PinOverflowError; pins that only fill the
 * seed budget `warn` and seed no tail.
 */
export async function planReplacementSeed(
  campaignRoot: string,
  kind: SeedKind,
  config: PlayConfig,
  warn: (message: string) => void,
): Promise<{ prime: ContextPrime; seedMessages?: SeedMessage[] }> {
  const rows = await readTranscript(campaignRoot);
  const prime = await buildContextPrime(campaignRoot, config);
  const estimate = config.estimateTokens ?? estimateTokensDefault;
  const seedBudget = compactSeedBudget(config);
  if (kind === "full") {
    if (rows.length === 0) return { prime };
    const handoff = buildHistoryHandoff("full");
    const fullSeedTokens = rows.reduce(
      (tokens, row) => tokens + estimate(`[${row.role}] ${row.text}`),
      0,
    );
    const fullSeedFits =
      prime.estimatedTokens + fullSeedTokens + estimate(handoff) <= seedBudget;
    if (fullSeedFits) {
      return {
        prime,
        seedMessages: [...dialogue(rows), { role: "system", content: handoff }],
      };
    }
  }
  const handoff = buildHistoryHandoff(kind === "fresh" ? "fresh" : "compact");
  const handoffTokens = estimate(handoff);
  const hardBudget = compactHardBudget(config);
  const estimatedWithHandoff = prime.estimatedTokens + handoffTokens;
  if (estimatedWithHandoff > hardBudget) {
    throw new PinOverflowError(
      `Context pins and compact handoff overflow budget: estimated ${estimatedWithHandoff} tokens > ${hardBudget} (ceiling ${config.compactCeilingTokens} − reserve ${config.completionReserveTokens})`,
      estimatedWithHandoff,
      hardBudget,
    );
  }
  // Pins are never trimmed, so the seed clamp can only squeeze the tail.
  const tailBudget = Math.max(0, seedBudget - estimatedWithHandoff);
  if (kind !== "fresh" && tailBudget === 0 && rows.length > 0) {
    warn(
      `Context pins fill the compact seed budget: estimated ${estimatedWithHandoff} tokens ≥ ${seedBudget} (${config.compactSeedPercent}% of ceiling ${config.compactCeilingTokens}). Seeding no transcript tail — trim story-beats.md or archive dossiers.`,
    );
  }
  const tail =
    kind === "fresh"
      ? []
      : selectTranscriptTail(rows, {
          maxTurns: config.hygieneN,
          maxTokens: tailBudget,
          estimateTokens: estimate,
        });
  return {
    prime,
    seedMessages: [...dialogue(tail), { role: "system", content: handoff }],
  };
}

/** Transcript rows as the session's prior dialogue. */
function dialogue(rows: TranscriptRow[]): SeedMessage[] {
  return rows.map((row) => ({
    role: row.role === "player" ? "user" : "assistant",
    content: row.text,
  }));
}
