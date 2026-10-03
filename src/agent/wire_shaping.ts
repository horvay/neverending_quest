/**
 * Request and reply shaping shared by the OMP adapter and the hosted browser
 * agent. Pure: no OMP, no Node, so the browser bundle can import it.
 */
import { DEFAULT_LOCAL_THINKING_OPENER } from "../play/scratch_format.ts";
import type { ContextFilePin } from "../play/types.ts";

/**
 * OMP replaces its rendered prompt when `systemPrompt` is a string, so pins
 * must be inlined. Passing `undefined` would install OMP's coding prompt.
 */
export function playProviderSystemPrompt(
  systemPrompt: string,
  contextFiles: ContextFilePin[],
): string {
  if (contextFiles.length === 0) return systemPrompt;
  const block = contextFiles
    .map((pin) => {
      if (pin.generated) {
        return pin.content.replace(/^# Dossier catalog\r?\n*/, "").trim();
      }
      return `<file path="${pin.path}">\n${pin.content}\n</file>`;
    })
    .join("\n");
  return `${systemPrompt}\n\n## Pinned Campaign memory\n${block}`;
}

export function prefillLocalThinking(
  payload: unknown,
  opener: string,
): unknown {
  const thinking = opener.trim() || DEFAULT_LOCAL_THINKING_OPENER;
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return payload;
  }
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return payload;
  }
  const last = body.messages.at(-1);
  // A user prompt starts a Scratch run; tool rows continue that same run.
  if (
    last === null ||
    typeof last !== "object" ||
    Array.isArray(last) ||
    !("role" in last) ||
    last.role !== "user"
  ) {
    return payload;
  }
  return {
    ...body,
    add_generation_prompt: false,
    continue_final_message: "reasoning_content",
    messages: [
      ...body.messages,
      {
        role: "assistant",
        content: "",
        reasoning_content: thinking,
      },
    ],
  };
}

const LOCAL_ANSWER_LABEL = "final answer:";

export function stripLeadingLocalAnswerLabel(text: string): string {
  return text.replace(/^\s*final answer:\s*/iu, "");
}

const INTERNAL_NOTES_HEADING =
  /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:\*{0,2}|_{0,2})notes(?:\*{0,2}|_{0,2})[ \t]*:?[ \t]*(?=\n|$)/iu;

export function stripTrailingInternalNotes(text: string): string {
  const heading = INTERNAL_NOTES_HEADING.exec(text);
  if (!heading || heading.index === 0) return heading ? "" : text;
  return text
    .slice(0, heading.index)
    .replace(/\s*<\/think>\s*$/iu, "")
    .trimEnd();
}

export function createLocalProseFilter() {
  let buffer = "";
  let decided = false;
  return {
    push(text: string): string {
      if (decided) return text;
      buffer += text;
      const candidate = buffer.trimStart();
      const lower = candidate.toLowerCase();
      if (LOCAL_ANSWER_LABEL.startsWith(lower)) return "";

      decided = true;
      const output = lower.startsWith(LOCAL_ANSWER_LABEL)
        ? candidate.slice(LOCAL_ANSWER_LABEL.length).replace(/^\s+/u, "")
        : buffer;
      buffer = "";
      return output;
    },
    reset(): void {
      buffer = "";
      decided = false;
    },
  };
}

const EFFORT_LADDER = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Maps NQ's (OMP's) reasoning ladder onto the `reasoning_effort` values a chat
 * template accepts: the level itself when allowed, else the next one up, else
 * the template's top level. Unknown levels land on the lowest.
 */
export function templateReasoningEffort(
  level: string | undefined,
  allowed: readonly string[],
): string {
  const rank = (value: string) => EFFORT_LADDER.indexOf(value);
  const ranked = allowed.filter((value) => rank(value) >= 0).sort((a, b) => rank(a) - rank(b));
  const wanted = (level ?? "").trim().toLowerCase();
  if (ranked.length === 0) return allowed[0] ?? wanted;
  if (rank(wanted) < 0) return ranked[0]!;
  return ranked.find((value) => rank(value) >= rank(wanted)) ?? ranked.at(-1)!;
}

/**
 * Qwen3.8's chat template takes its own `reasoning_effort` — `low`, `medium`
 * or `xhigh` — and defaults to `xhigh` when none is sent, whatever NQ's
 * reasoning setting says. Maps NQ's (OMP's) ladder onto those three levels.
 */
export function qwenReasoningEffort(level: string | undefined): "low" | "medium" | "xhigh" {
  return templateReasoningEffort(level, ["low", "medium", "xhigh"]) as "low" | "medium" | "xhigh";
}

/**
 * Pins the chat template's `reasoning_effort`. It goes both in the kwargs and
 * at top level: llama-server copies a top-level effort over the kwarg, so the
 * two must agree or the top-level one wins.
 */
export function setTemplateReasoningEffort(payload: unknown, effort: string): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const body = payload as Record<string, unknown>;
  const kwargs = body.chat_template_kwargs;
  return {
    ...body,
    chat_template_kwargs: {
      ...(kwargs !== null && typeof kwargs === "object" && !Array.isArray(kwargs) ? kwargs : {}),
      reasoning_effort: effort,
    },
    reasoning_effort: effort,
  };
}

/**
 * Qwen's recommended early-stop line: when the server's thinking budget runs
 * out it is inserted before the closing think tag, so the model moves to its
 * answer instead of stopping mid-thought.
 */
export const QWEN_BUDGET_STOP_MESSAGE =
  "\n\nConsidering the limited time by the user, I have to give the solution based on the thinking directly now.\n";

/**
 * DeepSeek-V4's Think Max: this paragraph opens the prompt, ahead of the
 * system text, in DeepSeek's reference encoder (encoding_dsv4.py,
 * REASONING_EFFORT_MAX). The GGUF chat template has no effort levels, so NQ
 * adds it. Think High is plain thinking and needs nothing.
 */
export const DEEPSEEK_V4_THINK_MAX =
  "Reasoning Effort: Absolute maximum with no shortcuts permitted.\n" +
  "You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.\n" +
  "Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.\n\n";

/** Puts DeepSeek-V4's Think Max paragraph at the front of the system message. */
export function prefixDeepSeekThinkMax(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.messages)) return payload;
  const messages = [...body.messages] as Array<Record<string, unknown>>;
  const first = messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    messages[0] = { ...first, content: DEEPSEEK_V4_THINK_MAX + first.content };
  } else {
    messages.unshift({ role: "system", content: DEEPSEEK_V4_THINK_MAX });
  }
  return { ...body, messages };
}

/**
 * Set one call's output limit (thinking, tool calls and reply together) to
 * `limit`, in whichever field the request uses: OMP sends llama.cpp models
 * their whole context as `max_completion_tokens`, which lets a runaway fill it.
 */
export function setMaxTokens(payload: unknown, limit: number): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const body = { ...(payload as Record<string, unknown>) };
  const field =
    ["max_output_tokens", "max_completion_tokens", "max_tokens"].find((key) => key in body) ??
    ("input" in body && !("messages" in body) ? "max_output_tokens" : "max_tokens");
  body[field] = limit;
  return body;
}
