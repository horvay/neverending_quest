/**
 * OMP agent events → the Play Loop's `AgentSessionEvent`s: thinking, prose,
 * tool calls and results. Anything else passes through as `debug`.
 */
import type { AgentSessionEvent } from "../../play/types.ts";

export function mapOmpEvent(ev: unknown): AgentSessionEvent | null {
  if (!ev || typeof ev !== "object") return null;
  const e = ev as {
    type?: string;
    assistantMessageEvent?: {
      type?: string;
      delta?: string;
      content?: string;
      contentIndex?: number;
      partial?: { content?: unknown };
    };
    toolName?: string;
    toolCallId?: string;
    args?: unknown;
    intent?: string;
    result?: unknown;
    isError?: boolean;
    message?: unknown;
  };
  if (e.type === "message_update") {
    const ame = e.assistantMessageEvent;
    if (ame?.type === "thinking_start") {
      return null;
    }
    if (
      ame?.type === "thinking_delta" &&
      typeof ame.delta === "string" &&
      ame.delta
    ) {
      return { type: "thinking_delta", text: ame.delta };
    }
    if (ame?.type === "thinking_end") {
      const text =
        (typeof ame.content === "string" && ame.content) ||
        thinkingTextFromPartial(ame);
      if (text) return { type: "thinking_delta", text, snapshot: true };
      return null;
    }
    if (ame?.type === "text_start") {
      return { type: "prose_reset" };
    }
    if (
      ame?.type === "text_delta" &&
      typeof ame.delta === "string" &&
      ame.delta
    ) {
      if (isThinkingPart(ame))
        return { type: "thinking_delta", text: ame.delta };
      return { type: "prose_delta", text: ame.delta };
    }
  }
  if (e.type === "tool_execution_start" && typeof e.toolName === "string") {
    const intent = typeof e.intent === "string" ? e.intent.trim() : "";
    return {
      type: "tool_call",
      name: e.toolName,
      args: e.args,
      ...(typeof e.toolCallId === "string" ? { toolCallId: e.toolCallId } : {}),
      ...(intent ? { intent } : {}),
    };
  }
  if (e.type === "tool_execution_end" && typeof e.toolName === "string") {
    return {
      type: "tool_result",
      name: e.toolName,
      result: e.result,
      isError: e.isError === true,
      ...(typeof e.toolCallId === "string" ? { toolCallId: e.toolCallId } : {}),
    };
  }
  return { type: "debug", payload: ev };
}

function isThinkingPart(ame: {
  type?: string;
  contentIndex?: number;
  partial?: { content?: unknown };
}): boolean {
  if (
    ame.type === "thinking_delta" ||
    ame.type === "thinking_start" ||
    ame.type === "thinking_end"
  ) {
    return true;
  }
  return thinkingTextFromPartial(ame).length > 0;
}

function thinkingTextFromPartial(ame: {
  contentIndex?: number;
  partial?: { content?: unknown };
}): string {
  const content = ame.partial?.content;
  if (!Array.isArray(content) || ame.contentIndex === undefined) return "";
  const part = content[ame.contentIndex];
  if (!part || typeof part !== "object") return "";
  const p = part as { type?: string; thinking?: string; text?: string };
  if (p.type !== "thinking" && p.type !== "reasoning") return "";
  if (typeof p.thinking === "string" && p.thinking) return p.thinking;
  if (typeof p.text === "string" && p.text) return p.text;
  return "";
}

export function extractAssistantText(msg: {
  content?: unknown;
  text?: unknown;
}): string {
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as { type?: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") return p.text;
        return "";
      })
      .join("");
  }
  return "";
}
