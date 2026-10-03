import { StyledText, dim, stringToStyledText } from "@opentui/core";
import type { ScratchRecord } from "../../../campaign/types.ts";
import {
  gmTurnsByIndex,
  type KernelState,
  type StoryBlock,
} from "../../../play/kernel.ts";
import { leafMarginPhrase } from "../../../play/leaf.ts";
import { formatScratchTools, liveScratchOpen } from "../../../play/scratch_format.ts";

const GM_TURN_GAP = "  ";
const RULE = "─".repeat(32);

/** Marks a Game Master row that has a kept Illustration. */
export const PICTURE_MARK = "· picture (/look)";

export function gmTurnLabel(turn: number): string {
  return `GM${GM_TURN_GAP}${turn}`;
}

export type StoryFormatOpts = {
  scratchByTs?: Map<string, ScratchRecord>;
  openScratchTs?: Set<string>;
  /** Lines drawn under the story while an Illustration is on the easel. */
  easel?: string[];
};

/** The latest row is the player's and has no reply: its Turn failed or stopped. */
export function unansweredRow(state: KernelState): StoryBlock | undefined {
  const last = state.story[state.story.length - 1];
  return state.phase === "idle" && last?.role === "player" && last.ts
    ? last
    : undefined;
}

export function formatStory(state: KernelState, opts?: StoryFormatOpts): string {
  const turns = gmTurnsByIndex(state.story, state.successTurnCount);
  const unanswered = unansweredRow(state);
  const parts: string[] = [];
  for (let i = 0; i < state.story.length; i++) {
    const b = state.story[i]!;
    const turn = turns.get(i);
    const who =
      b.role === "gm" && turn !== undefined ? gmTurnLabel(turn) : b.role === "gm" ? "GM" : "You";
    parts.push(b.role === "gm" && b.illustration ? `${who}  ${PICTURE_MARK}` : who);
    parts.push(RULE);
    parts.push(b.text);
    const record = b.ts ? opts?.scratchByTs?.get(b.ts) : undefined;
    if (b.role === "gm" && record && b.ts && opts?.openScratchTs?.has(b.ts)) {
      parts.push("Scratch");
      if (record.thinking) parts.push(record.thinking);
      const tools = formatScratchTools(record.tools);
      if (tools) parts.push(tools);
    }
    if (b === unanswered) {
      parts.push("");
      parts.push(state.lastError ?? "The Game Master has not answered this yet.");
      parts.push("Try again with /retry");
    }
    parts.push("");
  }
  if (state.phase === "turning" && liveScratchOpen(state.liveScratch)) {
    parts.push("Scratch");
    if (state.liveScratch.thinking) parts.push(state.liveScratch.thinking);
    const liveTools = formatScratchTools(state.liveScratch.tools);
    if (liveTools) parts.push(liveTools);
    parts.push("");
  }
  if (state.phase === "turning" && state.draft) {
    const last = state.story[state.story.length - 1];
    if (last?.role !== "gm") {
      parts.push("GM");
      parts.push(RULE);
      parts.push(state.draft);
      parts.push("");
    }
  }
  if (opts?.easel?.length) parts.push(...opts.easel, "");
  return parts.join("\n");
}

export type LuckView = { points: number; armed: boolean };

export function formatStatus(state: KernelState, luck?: LuckView): string {
  if (state.lastError && state.phase === "idle" && !unansweredRow(state)) {
    return state.lastError;
  }
  if (state.phase === "turning") return `Turning… · ${turnCount(state.successTurnCount)}`;
  if (state.phase === "hygiene") return state.status || "Memory hygiene…";
  if (state.phase === "compact") return "Rebuild-compaction…";
  const luckPart = luck ? ` · ${luckPhrase(luck)}` : "";
  const leaf = state.context
    ? ` · ${leafMarginPhrase(state.context.used, state.context.ceiling).phrase}`
    : "";
  return `Idle · ${turnCount(state.successTurnCount)}${luckPart}${leaf}`;
}

export function luckPhrase(luck: LuckView): string {
  return `Luck ${luck.points}${luck.armed ? " armed" : ""}`;
}

export function formatHistoryList(
  entries: Array<{ turn: number; prose: string }>,
): string {
  if (entries.length === 0) return "(no snapshots)";
  return entries.map((e) => `${e.turn} · ${e.prose}`).join("\n");
}

/** The story with each Game Master Turn number dimmed beside its label. */
export function dimGmTurns(text: string): StyledText {
  const chunks = [];
  const re = new RegExp(`^(GM${GM_TURN_GAP})(\\d+)`, "gm");
  let last = 0;
  let match: RegExpExecArray | null = re.exec(text);
  while (match) {
    if (match.index > last) {
      chunks.push(...stringToStyledText(text.slice(last, match.index)).chunks);
    }
    chunks.push(...stringToStyledText(match[1]!).chunks);
    chunks.push(dim(match[2]!));
    last = match.index + match[0].length;
    match = re.exec(text);
  }
  if (last < text.length) {
    chunks.push(...stringToStyledText(text.slice(last)).chunks);
  }
  return new StyledText(chunks);
}

export function lastGmTurn(
  story: StoryBlock[],
  successTurnCount: number,
): number | undefined {
  const turns = gmTurnsByIndex(story, successTurnCount);
  for (let i = story.length - 1; i >= 0; i--) {
    const turn = turns.get(i);
    if (turn !== undefined) return turn;
  }
  return undefined;
}

export function gmAtTurn(
  story: StoryBlock[],
  successTurnCount: number,
  turn: number,
): StoryBlock | undefined {
  const turns = gmTurnsByIndex(story, successTurnCount);
  for (let i = 0; i < story.length; i++) {
    if (turns.get(i) === turn) return story[i];
  }
  return undefined;
}

/**
 * The row Retry replays: the latest Turn's Game Master reply, or a player
 * line whose Turn failed without one.
 */
export function retryRow(state: KernelState): StoryBlock | undefined {
  const last = state.story[state.story.length - 1];
  const previous = state.story[state.story.length - 2];
  if (!last?.ts) return undefined;
  if (last.role === "player") return last;
  return previous?.role === "player" ? last : undefined;
}

function turnCount(n: number): string {
  return n === 1 ? "1 turn" : `${n} turns`;
}
