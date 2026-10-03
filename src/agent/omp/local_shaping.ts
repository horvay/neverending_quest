/**
 * Request shaping for a local llama.cpp Game Master, applied by an OMP
 * `before_provider_request` hook: the thinking prefill that opens play Turns,
 * DeepSeek-V4's think-max prefix, the chat template's reasoning effort, and
 * the reasoning-control fields the local host reads.
 */
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { LOCAL_REASONING_CLIENT_PID_FIELD } from "@nq/local-inference/host.ts";
import { isLlamaCppProvider } from "../llama_cpp.ts";
import {
  prefillLocalThinking,
  setMaxTokens,
  prefixDeepSeekThinkMax,
  setTemplateReasoningEffort,
  templateReasoningEffort,
} from "../wire_shaping.ts";

export function armLocalReasoningControl(
  payload: unknown,
  clientPid: number,
): unknown {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return payload;
  }
  return {
    ...(payload as Record<string, unknown>),
    reasoning_control: true,
    [LOCAL_REASONING_CLIENT_PID_FIELD]: clientPid,
  };
}

/**
 * Shared switch between the adapter's prompt() and the prefill hook. Hidden
 * passes (Memory Hygiene, illustration lookup) must not open with the Game
 * Master scene opener, or a local model answers the last play turn instead.
 *
 * One gate per OMP session, mutated in place: `adaptOmpSession`'s prompt()
 * sets it for the prompt it runs and resets it when that prompt ends. That is
 * sound only because the Play Loop never runs two prompts on one session at
 * once; a second concurrent prompt would see the first one's setting.
 */
export type LocalPrefillGate = {
  hidden: boolean;
  /** The running prompt's own opener, when it replaces the session's. */
  opener?: string;
};

/** What the request hook must know about the local model and its thinking. */
export type LocalModelShaping = {
  thinkingLevel?: string;
  /** Set once the session finds its model is a DeepSeek-V4 GGUF. */
  deepseekV4?: boolean;
  /**
   * The `reasoning_effort` values the model's chat template accepts (Qwen3.8:
   * low, medium, xhigh). The template thinks at its own default when none is
   * sent, and OMP's Qwen dialect never sends one.
   */
  reasoningEfforts?: string[];
};

export function createLocalThinkingPrefillExtension(
  opener: string,
  gate: LocalPrefillGate = { hidden: false },
  shaping: LocalModelShaping = {},
): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event, context) => {
      if (!isLlamaCppProvider(context.model?.provider)) return;
      let payload = event.payload;
      // the opener starts a reasoning block, so thinking "off" must skip it
      if (!gate.hidden && shaping.thinkingLevel !== "off") {
        payload = prefillLocalThinking(payload, gate.opener ?? opener);
      }
      // on every request, hidden ones too: it heads the cached prompt
      if (shaping.deepseekV4 && shaping.thinkingLevel === "max") {
        payload = prefixDeepSeekThinkMax(payload);
      }
      // on every request too: the template writes the effort into the system block
      if (shaping.reasoningEfforts && shaping.thinkingLevel !== "off") {
        payload = setTemplateReasoningEffort(
          payload,
          templateReasoningEffort(shaping.thinkingLevel, shaping.reasoningEfforts),
        );
      }
      return armLocalReasoningControl(payload, process.pid);
    });
  };
}

/**
 * Limits every llama.cpp-family call's output to the player's max tokens, so
 * a model that loops (say, on a tool call it never closes) fails in seconds
 * instead of filling its whole context. Cloud providers keep their own limits.
 */
export function createOutputCapExtension(
  maxTokens: () => number | undefined,
): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event, context) => {
      if (!isLlamaCppProvider(context.model?.provider)) return;
      const cap = maxTokens();
      if (!cap || cap <= 0) return;
      return setMaxTokens(event.payload, cap);
    });
  };
}
