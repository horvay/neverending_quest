import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
  AuthStorage,
  registerCustomApi,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type Usage,
} from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
  createOmpAgentFactory,
  type OmpFactoryOptions,
} from "../../src/agent/omp/factory.ts";
import type { AgentSessionFactory } from "../../src/play/types.ts";

/**
 * A scripted Game Master behind the real stack.
 *
 * Only the model is faked. Our OMP adapter, OMP's agent loop, the Campaign
 * tools and sandbox, and everything above them run for real: a script that
 * calls `edit` really edits a Campaign file, and a `roll` really rolls.
 *
 * Each model call runs one script step. A step streams thinking and prose as
 * it goes (so a test can act mid-reply), may call tools (OMP runs them and
 * calls the model again with the results), and may wait on the test.
 */

const SCRIPTED_API = "nq-scripted";

export type ModelCall = {
  /** 1-based index of this model call across the whole Game Master. */
  readonly index: number;
  /** Everything OMP sent: system prompt, messages, tools. */
  readonly context: Context;
  readonly signal?: AbortSignal;
  /** Text of the latest user message (the player's input). */
  readonly prompt: string;
  /**
   * Text of the latest user OR developer message. Hidden passes (Memory
   * Hygiene, compaction, illustration lookup) reach the model as developer
   * messages, so recognise them by this rather than `prompt`.
   */
  readonly instruction: string;
  /**
   * Every tool result since the latest instruction, in the order OMP
   * delivered them (parallel tools may finish out of call order; match on
   * `id`, which `tool()` returns).
   */
  readonly toolResults: Array<{ id: string; name: string; text: string }>;
  /** The system prompt OMP sent. */
  readonly system: string;
  /** Stream a piece of thinking. */
  think(text: string): void;
  /** Stream a piece of the reply. */
  say(text: string): void;
  /**
   * Ask OMP to run a tool; the model is called again with its result.
   * Returns the tool call id, which the matching tool result carries.
   */
  tool(name: string, args: Record<string, unknown>): string;
  /**
   * Report provider token usage for this reply, as a real provider does.
   * OMP anchors its live context occupancy on it (`input` + cache counts are
   * the prompt size), which is what the Play Loop reads as context used.
   */
  usage(tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>): void;
  /** Resolves when this call is aborted (the player pressed Stop). */
  aborted(): Promise<void>;
};

/** A step may return anything (e.g. the id from `tool()`); a promise is awaited. */
export type ScriptStep = (call: ModelCall) => unknown;

/** A step that just replies with `text`. */
export function says(text: string): ScriptStep {
  return (call) => call.say(text);
}

class ScriptedModel implements Model<Api> {
  readonly api = SCRIPTED_API as Api;
  readonly baseUrl = "scripted://";
  readonly input: ("text" | "image")[] = ["text"];
  readonly cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  readonly compat = undefined;
  readonly name: string;
  readonly calls: ModelCall[] = [];
  readonly steps: ScriptStep[];
  fallback?: ScriptStep;
  toolCallCounter = 0;

  constructor(
    readonly id: string,
    readonly provider: string,
    readonly contextWindow: number,
    readonly maxTokens: number,
    readonly reasoning: boolean,
    steps: ScriptStep[],
    fallback?: ScriptStep,
  ) {
    this.name = id;
    this.steps = [...steps];
    this.fallback = fallback;
  }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  } as Usage;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // system prompts arrive as string[]; message content as text blocks
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
    )
    .join("\n");
}

function streamScripted(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  if (!(model instanceof ScriptedModel)) {
    queueMicrotask(() =>
      stream.fail(new Error("scripted API called with a non-scripted model")),
    );
    return stream;
  }
  void runStep(stream, model, context, options);
  return stream;
}

async function runStep(
  stream: AssistantMessageEventStream,
  model: ScriptedModel,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<void> {
  const step = model.steps.shift() ?? model.fallback;
  const blocks: Array<TextContent | ThinkingContent | ToolCall> = [];
  const partial: AssistantMessage = {
    role: "assistant",
    content: blocks,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial });

  // one open block at a time, like a real provider's stream
  let open: { kind: "text" | "thinking"; index: number } | undefined;
  const close = () => {
    if (!open) return;
    const block = blocks[open.index]!;
    if (open.kind === "text") {
      stream.push({
        type: "text_end",
        contentIndex: open.index,
        content: (block as TextContent).text,
        partial,
      });
    } else {
      stream.push({
        type: "thinking_end",
        contentIndex: open.index,
        content: (block as ThinkingContent).thinking,
        partial,
      });
    }
    open = undefined;
  };
  const append = (kind: "text" | "thinking", delta: string) => {
    if (open?.kind !== kind) {
      close();
      blocks.push(
        kind === "text"
          ? { type: "text", text: "" }
          : { type: "thinking", thinking: "" },
      );
      open = { kind, index: blocks.length - 1 };
      stream.push({
        type: kind === "text" ? "text_start" : "thinking_start",
        contentIndex: open.index,
        partial,
      });
    }
    const block = blocks[open.index]!;
    if (kind === "text") {
      (block as TextContent).text += delta;
      stream.push({ type: "text_delta", contentIndex: open.index, delta, partial });
    } else {
      (block as ThinkingContent).thinking += delta;
      stream.push({
        type: "thinking_delta",
        contentIndex: open.index,
        delta,
        partial,
      });
    }
  };

  const messages = context.messages ?? [];
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  let lastInstruction = -1;
  messages.forEach((m, i) => {
    if (m.role === "user" || m.role === "developer") lastInstruction = i;
  });
  const toolResults = messages
    .slice(lastInstruction + 1)
    .filter((m) => m.role === "toolResult")
    .map((m) => ({
      id: String((m as { toolCallId?: unknown }).toolCallId ?? ""),
      name: String((m as { toolName?: unknown }).toolName ?? ""),
      text: textOf((m as { content?: unknown }).content),
    }));

  const call: ModelCall = {
    index: model.calls.length + 1,
    context,
    signal: options?.signal,
    prompt: lastUser >= 0 ? textOf(messages[lastUser]!.content) : "",
    instruction:
      lastInstruction >= 0 ? textOf(messages[lastInstruction]!.content) : "",
    toolResults,
    system: textOf(context.systemPrompt),
    think: (text) => append("thinking", text),
    say: (text) => append("text", text),
    tool: (name, args) => {
      close();
      model.toolCallCounter += 1;
      const toolCall: ToolCall = {
        type: "toolCall",
        id: `scripted-tc-${model.toolCallCounter}`,
        name,
        arguments: { ...args },
      } as ToolCall;
      blocks.push(toolCall);
      const index = blocks.length - 1;
      stream.push({ type: "toolcall_start", contentIndex: index, partial });
      stream.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: JSON.stringify(args),
        partial,
      });
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial });
      return toolCall.id;
    },
    usage: (tokens) => {
      const usage = partial.usage;
      Object.assign(usage, tokens);
      usage.totalTokens =
        usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    },
    aborted: () =>
      new Promise<void>((resolve) => {
        const signal = options?.signal;
        if (!signal || signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  };
  model.calls.push(call);

  if (!step) {
    partial.stopReason = "error";
    partial.errorMessage = `scripted Game Master has no step for call ${call.index}`;
    stream.push({ type: "error", reason: "error", error: partial });
    return;
  }

  try {
    await step(call);
  } catch (err) {
    close();
    partial.stopReason = "error";
    partial.errorMessage = err instanceof Error ? err.message : String(err);
    stream.push({ type: "error", reason: "error", error: partial });
    return;
  }
  close();
  if (options?.signal?.aborted) {
    partial.stopReason = "aborted";
    partial.errorMessage = "aborted";
    stream.push({ type: "error", reason: "aborted", error: partial });
    return;
  }
  const toolUse = blocks.some((b) => b.type === "toolCall");
  partial.stopReason = toolUse ? "toolUse" : "stop";
  stream.push({
    type: "done",
    reason: toolUse ? "toolUse" : "stop",
    message: partial,
  });
}

registerCustomApi(SCRIPTED_API, streamScripted, "nq-tests/scripted");

export type ScriptedGameMaster = {
  /** The real OMP-backed factory, wired to the scripted model. */
  readonly factory: AgentSessionFactory;
  /** Every model call so far, in order. */
  readonly calls: ModelCall[];
  /** Queue more steps (run before the fallback). Not `then`: that would make this a thenable. */
  queue(...steps: ScriptStep[]): void;
};

/**
 * One in-memory OMP auth store and model registry per test process: building
 * them loads OMP's whole bundled catalog (~10ms), and the scripted model is
 * handed to OMP directly, so the registry only has to vouch for its key.
 */
let registry:
  | Promise<{ authStorage: AuthStorage; modelRegistry: ModelRegistry }>
  | undefined;
function sharedRegistry() {
  registry ??= AuthStorage.create(":memory:").then((authStorage) => ({
    authStorage,
    modelRegistry: new ModelRegistry(authStorage),
  }));
  return registry;
}

/**
 * Build the real Game Master factory over a scripted model.
 *
 * `steps` run one per model call, in order; `fallback` answers any call after
 * them. With neither, every call replies "The story continues."
 */
export async function scriptedGameMaster(
  opts: {
    steps?: ScriptStep[];
    fallback?: ScriptStep;
    /** Provider id; use a `llama.cpp` one to exercise local-model paths. */
    provider?: string;
    id?: string;
    contextWindow?: number;
    reasoning?: boolean;
    factory?: Omit<OmpFactoryOptions, "connection" | "model">;
  } = {},
): Promise<ScriptedGameMaster> {
  const provider = opts.provider ?? "scripted";
  const model = new ScriptedModel(
    opts.id ?? "game-master",
    provider,
    opts.contextWindow ?? 200_000,
    32_768,
    opts.reasoning ?? false,
    opts.steps ?? [],
    opts.fallback ??
      (opts.steps ? undefined : says("The story continues.")),
  );
  const { authStorage, modelRegistry } = await sharedRegistry();
  authStorage.setConfigApiKey(provider, "test-key");
  return {
    factory: createOmpAgentFactory({
      ...opts.factory,
      connection: { model, modelRegistry },
    }),
    calls: model.calls,
    queue: (...steps) => {
      model.steps.push(...steps);
    },
  };
}
