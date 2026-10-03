import type { ScratchTool } from "../campaign/types.ts";
import { composeContinuedProse } from "./continue_prose.ts";
import type { ContextUsage } from "./leaf.ts";
import type { LiveScratch } from "./scratch_format.ts";
import type { FailReason, PlayEvent } from "./types.ts";

export type KernelPhase = "idle" | "turning" | "hygiene" | "compact";

export type StoryBlock = {
  role: "player" | "gm";
  text: string;
  /** Transcript row stamp when loaded from disk so HTTP edit/delete can key by `ts`. */
  ts?: string;
  /** listGmTurns number. Continue must POST this, not success_turn_count. */
  turn?: number;
  /** GM row `ts` when this block has an Illustration. */
  illustration?: string;
  /** Anima prompt used to paint that sitting. */
  illustrationPrompt?: string;
};

/**
 * Continue / labels. Prefer each GM block's listGmTurns stamp so a drifted
 * success_turn_count or a serve tail cannot invent a turn the server lacks.
 */
export function gmTurnsByIndex(
  story: StoryBlock[],
  successTurnCount: number,
): Map<number, number> {
  const turns = new Map<number, number>();
  let expected: number | undefined;
  for (let i = 0; i < story.length; i++) {
    if (story[i]!.role !== "gm") continue;
    const stamped = story[i]!.turn;
    if (stamped !== undefined) {
      turns.set(i, stamped);
      expected = stamped + 1;
    } else if (expected !== undefined) {
      turns.set(i, expected);
      expected += 1;
    }
  }
  if (turns.size > 0) return turns;
  let turn = successTurnCount;
  for (let i = story.length - 1; i >= 0; i--) {
    if (story[i]!.role !== "gm") continue;
    turns.set(i, turn);
    turn -= 1;
  }
  return turns;
}

export type MaintenanceScratch = LiveScratch & {
  task: "hygiene" | "compact";
  mode?: "light" | "heavy";
  /** Insert after this many story rows so later Turns flow beneath it. */
  afterStoryCount: number;
  live: boolean;
  ok?: boolean;
};

export type KernelState = {
  phase: KernelPhase;
  story: StoryBlock[];
  draft: string;
  status: string;
  lastError?: string;
  busy: boolean;
  successTurnCount: number;
  /** Original GM prefix while Continue is streaming into the last row. */
  extendStub?: string;
  /** Inner work of the in-flight Turn. Cleared when the Turn ends. */
  liveScratch?: LiveScratch;
  /** Live maintenance work, retained as a collapsed record after completion. */
  maintenanceScratch?: MaintenanceScratch;
  /** OMP session occupancy vs NQ compact ceiling (the inkwell). */
  context?: ContextUsage;
};

export type KernelSnapshot = KernelState;

export function createKernel(init?: Partial<KernelState>): KernelState {
  const phase = init?.phase ?? "idle";
  return {
    phase,
    story: init?.story ? [...init.story] : [],
    draft: init?.draft ?? "",
    status: init?.status ?? "",
    lastError: init?.lastError,
    busy: init?.busy ?? phase !== "idle",
    successTurnCount: init?.successTurnCount ?? 0,
    extendStub: init?.extendStub,
    liveScratch: init?.liveScratch
      ? {
          thinking: init.liveScratch.thinking,
          tools: init.liveScratch.tools.map(copyScratchTool),
        }
      : undefined,
    maintenanceScratch: init?.maintenanceScratch
      ? copyMaintenanceScratch(init.maintenanceScratch)
      : undefined,
    context: init?.context
      ? { used: init.context.used, ceiling: init.context.ceiling }
      : undefined,
  };
}

/** What the player reads when a Turn ends with no reply and no error of its own. */
function failNotice(reason: FailReason | undefined): string | undefined {
  switch (reason) {
    case "empty_prose":
      return "The Game Master finished without replying. Retry your message to try again.";
    case "timeout":
      return "The Game Master stopped responding, so the Turn was ended. Retry your message to try again.";
    case "repetition":
      return "The Game Master kept repeating itself, so the Turn was ended. Retry your message to try again.";
    case "agent_error":
      return "The Game Master ran into an error. Retry your message to try again.";
    case "missing_seed":
      return "This campaign has no seed, so the Game Master cannot play it.";
    default:
      // Stop, or a Turn that never started
      return undefined;
  }
}

export function applyPlayEvent(
  state: KernelState,
  event: PlayEvent,
): KernelState {
  switch (event.type) {
    case "turn_started":
      if (event.extend) {
        return {
          ...state,
          phase: "turning",
          busy: true,
          draft: "",
          lastError: undefined,
          status: "",
          extendStub: lastGmText(state.story),
          liveScratch: undefined,
        };
      }
      return {
        ...state,
        phase: "turning",
        busy: true,
        draft: "",
        lastError: undefined,
        status: "",
        extendStub: undefined,
        liveScratch: undefined,
        story: [
          ...state.story,
          storyBlock("player", event.playerText, event.ts),
        ],
      };
    case "prose_delta": {
      const draft = state.draft + event.text;
      if (state.extendStub === undefined) {
        return { ...state, draft };
      }
      return {
        ...state,
        draft,
        story: replaceLastGm(
          state.story,
          composeContinuedProse(state.extendStub, draft),
        ),
      };
    }
    case "prose_reset":
      if (state.extendStub === undefined) {
        return { ...state, draft: "" };
      }
      return {
        ...state,
        draft: "",
        story: replaceLastGm(state.story, state.extendStub),
      };
    case "turn_ended":
      if (event.extend && event.outcome === "success" && event.prose?.trim()) {
        return {
          ...state,
          phase: "idle",
          busy: false,
          draft: "",
          extendStub: undefined,
          liveScratch: undefined,
          story: replaceLastGm(state.story, event.prose, event.ts),
        };
      }
      if (event.extend) {
        return {
          ...state,
          phase: "idle",
          busy: false,
          draft: "",
          lastError: state.lastError ?? failNotice(event.reason),
          extendStub: undefined,
          liveScratch: undefined,
          story:
            state.extendStub !== undefined
              ? replaceLastGm(state.story, state.extendStub)
              : state.story,
        };
      }
      if (event.outcome === "success" && event.prose?.trim()) {
        return {
          ...state,
          phase: "idle",
          busy: false,
          draft: "",
          liveScratch: undefined,
          successTurnCount: state.successTurnCount + 1,
          story: [...state.story, storyBlock("gm", event.prose, event.ts)],
        };
      }
      return {
        ...state,
        phase: "idle",
        busy: false,
        draft: "",
        // a Turn that ends without a reply says why, unless the player stopped it
        lastError: state.lastError ?? failNotice(event.reason),
        extendStub: undefined,
        liveScratch: undefined,
      };
    case "status":
      return { ...state, status: event.message };
    case "error":
      return { ...state, lastError: event.message };
    case "hygiene_started":
      // Compact nests heavy hygiene; stay compact until compact_ended.
      if (state.phase === "compact") {
        return {
          ...state,
          busy: true,
          maintenanceScratch: {
            ...(state.maintenanceScratch ?? {
              task: "compact",
              thinking: "",
              tools: [],
              afterStoryCount: state.story.length,
            }),
            live: true,
          },
        };
      }
      return {
        ...state,
        phase: "hygiene",
        busy: true,
        liveScratch: undefined,
        maintenanceScratch: {
          task: "hygiene",
          mode: event.mode,
          thinking: "",
          tools: [],
          afterStoryCount: state.story.length,
          live: true,
        },
      };
    case "hygiene_ended":
      if (state.phase === "compact") {
        return {
          ...state,
          busy: true,
          lastError: event.ok ? state.lastError : (event.error ?? "hygiene failed"),
        };
      }
      return {
        ...state,
        phase: "idle",
        busy: false,
        lastError: event.ok ? state.lastError : (event.error ?? "hygiene failed"),
        maintenanceScratch: state.maintenanceScratch
          ? { ...state.maintenanceScratch, live: false, ok: event.ok }
          : undefined,
      };
    case "compact_started":
      return {
        ...state,
        phase: "compact",
        busy: true,
        liveScratch: undefined,
        maintenanceScratch: {
          task: "compact",
          thinking: "",
          tools: [],
          afterStoryCount: state.story.length,
          live: true,
        },
      };
    case "compact_ended":
      return {
        ...state,
        phase: "idle",
        busy: false,
        lastError: event.ok ? state.lastError : (event.error ?? "compact failed"),
        maintenanceScratch: state.maintenanceScratch
          ? { ...state.maintenanceScratch, live: false, ok: event.ok }
          : undefined,
      };
    case "agent_debug":
    case "roll":
    case "illustrate_prompt":
    case "illustrate_candidate":
      return state;
    case "illustrate_started":
      return { ...state, busy: true };
    case "illustrate_ended":
      return { ...state, busy: event.ok };
    case "illustrate_picked":
    case "illustrate_cancelled":
      return { ...state, busy: false };
    case "context":
      return {
        ...state,
        context: { used: event.used, ceiling: event.ceiling },
      };
    case "scratch_live":
      if (state.phase === "turning") {
        return {
          ...state,
          liveScratch: {
            thinking: event.thinking,
            tools: event.tools.map(copyScratchTool),
          },
        };
      }
      if (
        (state.phase === "hygiene" || state.phase === "compact") &&
        state.maintenanceScratch
      ) {
        return {
          ...state,
          maintenanceScratch: {
            ...state.maintenanceScratch,
            thinking: event.thinking,
            tools: event.tools.map(copyScratchTool),
          },
        };
      }
      return state;
    case "story_replaced":
      return {
        ...state,
        phase: event.busy ? "turning" : "idle",
        busy: Boolean(event.busy),
        draft: "",
        extendStub: undefined,
        liveScratch: undefined,
        story: event.story.map((block) => ({ ...block })),
        successTurnCount: event.successTurnCount,
      };
    default:
      return state;
  }
}

function copyScratchTool(tool: ScratchTool): ScratchTool {
  const out: ScratchTool = { name: tool.name };
  if (tool.path) out.path = tool.path;
  if (tool.wrote) out.wrote = true;
  if (tool.n !== undefined) out.n = tool.n;
  if (tool.value !== undefined) out.value = tool.value;
  if (tool.reason) out.reason = tool.reason;
  if (tool.query) out.query = tool.query;

  return out;
}
function copyMaintenanceScratch(
  scratch: MaintenanceScratch,
): MaintenanceScratch {
  return {
    task: scratch.task,
    ...(scratch.mode ? { mode: scratch.mode } : {}),
    thinking: scratch.thinking,
    tools: scratch.tools.map(copyScratchTool),
    afterStoryCount: scratch.afterStoryCount,
    live: scratch.live,
    ...(scratch.ok !== undefined ? { ok: scratch.ok } : {}),
  };
}

function storyBlock(
  role: "player" | "gm",
  text: string,
  ts?: string,
  illustration?: string,
  illustrationPrompt?: string,
): StoryBlock {
  const block: StoryBlock = ts ? { role, text, ts } : { role, text };
  if (illustration) block.illustration = illustration;
  if (illustrationPrompt) block.illustrationPrompt = illustrationPrompt;
  return block;
}

function lastGmText(story: StoryBlock[]): string {
  for (let i = story.length - 1; i >= 0; i--) {
    if (story[i]!.role === "gm") return story[i]!.text;
  }
  return "";
}

function replaceLastGm(
  story: StoryBlock[],
  text: string,
  ts?: string,
): StoryBlock[] {
  const next = story.map((block) => ({ ...block }));
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]!.role !== "gm") continue;
    const prev = next[i]!;
    next[i] = {
      role: "gm",
      text,
      ts: ts ?? prev.ts,
      ...(prev.turn !== undefined ? { turn: prev.turn } : {}),
      ...(prev.illustration ? { illustration: prev.illustration } : {}),
      ...(prev.illustrationPrompt
        ? { illustrationPrompt: prev.illustrationPrompt }
        : {}),
    };
    break;
  }
  return next;
}
