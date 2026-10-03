import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildDossierCatalogMarkdown,
  GENERATED_DOSSIER_CATALOG_PATH,
} from "../campaign/catalog.ts";
import {
  PLAYER_SHEET_MD,
  QUEST_LOG_MD,
  SEED_MD,
  STORY_BEATS_MD,
  TWISTS_MD,
  WORLD_BUILDING_MD,
} from "../campaign/paths.ts";
import type { ContextFilePin, ContextPrime, PlayConfig } from "./types.ts";
import runtimeContract from "./runtime_contract.md" with { type: "text" };
import { estimateTokensDefault } from "./tokens.ts";

export { estimateTokensDefault };



export const RUNTIME_CONTRACT = runtimeContract.trimEnd();

export const DEFAULT_GM_VOICE_PATH = path.join(import.meta.dir, "gm_voice.md");


export class GmVoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmVoiceError";
  }
}

export async function loadGmVoice(overridePath?: string): Promise<string> {
  const target = overridePath?.trim() || DEFAULT_GM_VOICE_PATH;
  try {
    return (await readFile(target, "utf8")).trim();
  } catch {
    throw new GmVoiceError(`Game Master voice file missing or unreadable: ${target}`);
  }
}

/**
 * Without a word on what it is for, a bare personality line reads as a stray
 * note beside the voice rules and has no effect.
 */
const PERSONALITY_FRAME =
  "The player chose who you are as the Game Master. Let this color the whole telling: what you linger on, your word choices, your humor, and how scenes feel. It shapes your voice within the rules above and never turns into notes or commentary.";

export function composeSystemPrompt(
  voice: string,
  seed: string,
  personality?: string,
): string {
  const scenario = seed.trimEnd();
  const personalityBlock = personality?.trim()
    ? `# Game Master personality\n\n${PERSONALITY_FRAME}\n\n${personality.trim()}`
    : "";
  const parts = [
    voice.trim(),
    personalityBlock,
    scenario.length > 0 ? `# The Scenario\n\n${scenario}` : "",
    RUNTIME_CONTRACT,
  ];
  return parts.filter((p) => p.length > 0).join("\n\n");
}

/** Hard wall for anything seeded into a session: pins may never cross it. */
export function compactHardBudget(
  config: Pick<PlayConfig, "compactCeilingTokens" | "completionReserveTokens">,
): number {
  return Math.max(0, config.compactCeilingTokens - config.completionReserveTokens);
}

/**
 * Soft target for a rebuilt session: `compact.seed_percent` of the ceiling,
 * never above the hard wall. Compaction can only reclaim dialogue, so this is
 * what keeps a rebuild from landing just under the ceiling it just crossed.
 */
export function compactSeedBudget(
  config: Pick<
    PlayConfig,
    "compactCeilingTokens" | "completionReserveTokens" | "compactSeedPercent"
  >,
): number {
  const percent = Math.min(100, Math.max(0, config.compactSeedPercent));
  const clamped = Math.floor((config.compactCeilingTokens * percent) / 100);
  return Math.max(0, Math.min(compactHardBudget(config), clamped));
}


export async function buildContextPrime(
  campaignPath: string,
  config: Pick<
    PlayConfig,
    | "estimateTokens"
    | "compactCeilingTokens"
    | "completionReserveTokens"
    | "gmVoicePath"
    | "gmPersonality"
  >,
): Promise<ContextPrime> {
  const estimate = config.estimateTokens ?? estimateTokensDefault;
  const seed = await readFile(path.join(campaignPath, SEED_MD), "utf8");
  const voice = await loadGmVoice(config.gmVoicePath);
  const systemPrompt = composeSystemPrompt(voice, seed, config.gmPersonality);

  const pins: ContextFilePin[] = [
    {
      path: PLAYER_SHEET_MD,
      content: await readFile(path.join(campaignPath, PLAYER_SHEET_MD), "utf8"),
    },
    {
      path: WORLD_BUILDING_MD,
      content: await readFile(path.join(campaignPath, WORLD_BUILDING_MD), "utf8"),
    },
    {
      path: QUEST_LOG_MD,
      content: await readFile(path.join(campaignPath, QUEST_LOG_MD), "utf8"),
    },
    {
      path: STORY_BEATS_MD,
      content: await readFile(path.join(campaignPath, STORY_BEATS_MD), "utf8"),
    },
    {
      path: TWISTS_MD,
      content: await readFile(path.join(campaignPath, TWISTS_MD), "utf8"),
    },
    {
      path: GENERATED_DOSSIER_CATALOG_PATH,
      content: await buildDossierCatalogMarkdown(campaignPath),
      generated: true,
    },
  ];

  const estimatedTokens =
    estimate(systemPrompt) + pins.reduce((n, p) => n + estimate(p.content), 0);

  const budget = compactHardBudget(config);

  if (estimatedTokens > budget) {
    throw new PinOverflowError(
      `Context pins overflow budget: estimated ${estimatedTokens} tokens > ${budget} (ceiling ${config.compactCeilingTokens} − reserve ${config.completionReserveTokens})`,
      estimatedTokens,
      budget,
    );
  }

  return { systemPrompt, contextFiles: pins, estimatedTokens };
}

/** Sheet + live catalog only — what the Illustration looker needs for visuals. */
export async function buildIllustrationLookerPins(
  campaignPath: string,
): Promise<ContextFilePin[]> {
  return [
    {
      path: PLAYER_SHEET_MD,
      content: await readFile(path.join(campaignPath, PLAYER_SHEET_MD), "utf8"),
    },
    {
      path: GENERATED_DOSSIER_CATALOG_PATH,
      content: await buildDossierCatalogMarkdown(campaignPath),
      generated: true,
    },
  ];
}

export class PinOverflowError extends Error {
  readonly estimated: number;
  readonly budget: number;
  constructor(message: string, estimated: number, budget: number) {
    super(message);
    this.name = "PinOverflowError";
    this.estimated = estimated;
    this.budget = budget;
  }
}

export function buildHistoryHandoff(kind: "full" | "compact" | "fresh"): string {
  const history =
    kind === "full"
      ? [
          "[System handoff after full-history rebuild]",
          "The historical player and Game Master dialogue is above.",
        ]
      : kind === "fresh"
        ? [
            "[System handoff after rebuild-compaction]",
            "Older activity is summarized in Story Beats (pinned).",
            "This session has no prior player or Game Master dialogue.",
            "Read a dossier body only when you need a fact. Chronicle belongs in Story Beats, not in a dossier.",
          ]
        : [
            "[System handoff after rebuild-compaction]",
            "Older activity is summarized in Story Beats (pinned).",
            "The recent player and Game Master dialogue is above.",
            "Read a dossier body only when you need a fact. Chronicle belongs in Story Beats, not in a dossier.",
          ];
  const direction =
    kind === "fresh"
      ? "Continue as Game Master using the current system voice. Reply only with finished story prose."
      : "Continue as Game Master using the current system voice, not the style of the historical dialogue. Reply only with finished story prose.";
  return [...history, direction].join(" ");
}

export function selectTranscriptTail<
  T extends { role: string; text: string; ts: string },
>(
  rows: T[],
  opts: {
    maxTurns: number;
    maxTokens: number;
    estimateTokens?: (text: string) => number;
  },
): T[] {
  const maxTurns = Math.max(0, Math.floor(opts.maxTurns));
  const maxTokens = Math.max(0, Math.floor(opts.maxTokens));
  if (rows.length === 0 || maxTurns === 0 || maxTokens === 0) return [];

  const estimate = opts.estimateTokens ?? estimateTokensDefault;
  let start = rows.length;
  let turns = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.role !== "gm") continue;
    turns += 1;
    if (turns !== maxTurns) continue;
    start = i;
    while (start > 0 && rows[start - 1]!.role !== "gm") start -= 1;
    break;
  }
  if (turns < maxTurns) start = 0;

  let used = 0;
  for (let i = start; i < rows.length; i++) {
    const row = rows[i]!;
    used += estimate(`[${row.role}] ${row.text}`);
  }

  while (start < rows.length && used > maxTokens) {
    let next = start;
    while (next < rows.length && rows[next]!.role !== "gm") next += 1;
    if (next < rows.length) next += 1;
    for (let i = start; i < next; i++) {
      const row = rows[i]!;
      used -= estimate(`[${row.role}] ${row.text}`);
    }
    start = next;
  }

  return rows.slice(start);
}
