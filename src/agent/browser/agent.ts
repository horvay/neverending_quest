/**
 * The hosted Game Master: an `AgentSessionFactory` the Play Loop drives in
 * place of the OMP adapter, for the browser build (ADR-0008). It runs the tool
 * loop itself — streaming chat completions to the Atomic llama-server behind
 * the sealed relay, running Campaign tools between rounds — and shapes each
 * request the way the OMP adapter does for a `llama.cpp-*` provider (thinking
 * prefill, preserved thinking, reasoning control, prose filter).
 *
 * History is an in-memory message list: hidden passes (Memory Hygiene) roll it
 * back afterwards, and there is no journal to resume, so the Play Loop re-primes
 * a fresh session from the Campaign folder on open.
 */
import {
  createLocalProseFilter,
  playProviderSystemPrompt,
  prefillLocalThinking,
  QWEN_BUDGET_STOP_MESSAGE,
  qwenReasoningEffort,
  stripLeadingLocalAnswerLabel,
  stripTrailingInternalNotes,
} from "../wire_shaping.ts";
import { RUNTIME_CONTRACT } from "../../play/context.ts";
import { createSandbox, PLAY_TOOL_NAMES } from "../../play/sandbox.ts";
import { estimateTokensDefault } from "../../play/tokens.ts";
import type {
  AgentPromptResult,
  AgentSession,
  AgentSessionEvent,
  AgentSessionFactory,
  SessionCreateOptions,
} from "../../play/types.ts";
import type { SealedFetch } from "@nq/seal/browser.ts";
import { RelayError } from "@nq/seal/browser.ts";
import { runTool, toolSpecs } from "./tools.ts";

/**
 * DeepSeek V4 was trained on a roleplay switch appended to the end of the
 * first user message (deepseek_v4_rolepaly_instruct): "Role Immersion" makes
 * its thinking a first-person inner monologue in parentheses. The role here
 * is the Game Master in person, so the Scratch reads as someone running the
 * table rather than a machine planning a scene. Measured on V4 Flash:
 * - the trigger as published turned thinking (7/8) and some replies Chinese,
 *   and thought as Mira instead of the Game Master;
 * - an English-only instruction left the voice unchanged (8/8 analysis);
 * - this wording, the trained trigger naming the Game Master and requiring
 *   English, gave English first-person thinking and replies in 16/16, with
 *   rolls as reliable as without it.
 */
const DEEPSEEK_V4_IMMERSION =
  "\n\n【角色沉浸要求】在你的思考过程（<think>标签内）中，请遵守以下规则：\n" +
  "1. 你的角色是游戏主持人（Game Master）本人：为玩家主持这场游戏的人，不是故事里的任何人物。请以游戏主持人的第一人称进行内心独白，用括号包裹内心活动，例如\"(Okay, ...)\"\n" +
  "2. 用第一人称描写你作为主持人的内心感受，例如\"I think\"\"I like this\"\"I want\"等\n" +
  "3. 思考内容应沉浸在角色中，通过内心独白分析剧情和规划回复\n" +
  "4. 思考和回复都只用英文。需要掷骰时，照常调用 roll 工具。";

/** Text a model family needs at the end of the first user message, if any. */
export function firstTurnNote(modelId: string | undefined): string {
  return /deepseek-v4/i.test(modelId ?? "") ? DEEPSEEK_V4_IMMERSION : "";
}

export type HostedAgentOptions = {
  /**
   * How a chat completion reaches the model: the sealed Runpod worker, or the
   * relay's OpenRouter route. Same shape as `fetch` for a path and init.
   */
  transport: SealedFetch;
  /**
   * The request dialect. "atomic" is our llama-server (thinking prefill,
   * Qwen template kwargs, reasoning budget); "openai" is OpenRouter's
   * (`reasoning.effort`, `session_id`, reasoning in `reasoning_details`).
   */
  dialect?: "atomic" | "openai";
  /** The model the relay serves, when it says (OpenRouter), for model-specific wiring. */
  modelId?: string;
  /** Model name llama-server answers to. */
  model?: string;
  /** Reasoning prefix continued inside the model's thinking block. */
  thinkingOpener?: string;
  /**
   * NQ's reasoning setting (low, medium, high…), read on every request so a
   * change in Settings applies to the next call. Default low.
   */
  reasoning?: () => string | undefined;
  /** Output limit per call; a function is read on every call. */
  maxTokens?: number | (() => number);
  /** Tool rounds allowed in one prompt before it is failed as runaway. */
  maxToolRounds?: number;
  /**
   * How long to keep retrying a Game Master that is still waking (Runpod
   * scales to zero; a cold worker can take a couple of minutes).
   */
  wakeBudgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * While a call waits for its first token (a cold worker booting), report
   * activity this often so the Play Loop's inactivity timeout does not end
   * the Turn. Default 5s.
   */
  heartbeatMs?: number;
  /** Per-request cap on thinking tokens; the server's own cap applies without it. */
  reasoningBudgetTokens?: number;
  /** Told what a new session's prompt is made of, before its first call. */
  onPromptBreakdown?: (parts: PromptPart[]) => void;
  /** Told the real token counts llama-server reports for each call. */
  onUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    /** Prompt tokens served from the provider's cache, when it says. */
    cachedTokens?: number;
    /** What the call cost in dollars, when the provider says (OpenRouter does). */
    cost?: number;
  }) => void;
};

/** One piece of the prompt a session starts from, in estimated tokens (chars / 4). */
export type PromptPart = { part: string; tokens: number };

/**
 * What a session's prompt is built from: the Game Master voice, the seed,
 * the runtime contract, each pinned memory file, the tool schemas, and any
 * transcript tail seeded into a rebuilt session.
 */
export function promptBreakdown(
  create: SessionCreateOptions,
  tools: readonly string[],
): PromptPart[] {
  const est = estimateTokensDefault;
  const parts: PromptPart[] = [];
  const system = create.systemPrompt;
  const scenarioAt = system.indexOf("\n\n# The Scenario\n\n");
  const contractAt = system.lastIndexOf(RUNTIME_CONTRACT);
  const head = scenarioAt >= 0 ? system.slice(0, scenarioAt) : system.slice(0, Math.max(0, contractAt));
  const personalityAt = head.indexOf("\n\n# Game Master personality\n\n");
  if (personalityAt >= 0) {
    parts.push({ part: "Game Master voice", tokens: est(head.slice(0, personalityAt)) });
    parts.push({ part: "Game Master personality", tokens: est(head.slice(personalityAt)) });
  } else {
    parts.push({ part: "Game Master voice", tokens: est(head) });
  }
  if (scenarioAt >= 0) {
    const end = contractAt > scenarioAt ? contractAt : system.length;
    parts.push({ part: "seed.md (scenario)", tokens: est(system.slice(scenarioAt, end)) });
  }
  if (contractAt >= 0) parts.push({ part: "runtime contract", tokens: est(RUNTIME_CONTRACT) });
  for (const pin of create.contextFiles) {
    parts.push({ part: pin.path, tokens: est(pin.content) });
  }
  parts.push({ part: `tool schemas (${tools.join(", ")})`, tokens: est(JSON.stringify(toolSpecs(tools))) });
  const seeded = create.seedMessages ?? [];
  if (seeded.length > 0) {
    parts.push({
      part: `transcript tail + handoff (${seeded.length} messages)`,
      tokens: seeded.reduce((n, m) => n + est(m.content), 0),
    });
  }
  return parts;
}

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; reasoning_content?: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

type Completion = {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage?: number;
};

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MAX_TOOL_ROUNDS = 40;
const DEFAULT_WAKE_BUDGET_MS = 240_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
/** Answers a load balancer gives while a scale-to-zero worker boots. */
const WAKING_STATUS = new Set([429, 502, 503, 504, 520, 522, 524]);

export function createHostedAgentFactory(opts: HostedAgentOptions): AgentSessionFactory {
  return {
    async create(createOpts: SessionCreateOptions): Promise<AgentSession> {
      const sandbox =
        createOpts.sandbox ?? (await createSandbox({ campaignRoot: createOpts.cwd }));
      return hostedSession(opts, createOpts, sandbox);
    },
  };
}

class AbortedError extends Error {}

/**
 * Appends a note to the first user message of the conversation as sent. It is
 * added on every request, never stored, so history and the cached prefix stay
 * the same from call to call.
 */
function withFirstTurnNote<M extends { role: string; content?: unknown }>(messages: M[], note: string): M[] {
  if (!note) return messages;
  const first = messages.findIndex((m) => m.role === "user");
  if (first < 0) return messages;
  return messages.map((m, i) =>
    i === first && typeof m.content === "string" ? { ...m, content: m.content + note } : m,
  );
}

/** The model's thinking decided on a roll, and it began its reply without making it. */
class RollSkipped extends Error {}

/**
 * Words a model uses when it decides to roll. Some models (DeepSeek V4 Flash,
 * about 1 Turn in 8 when measured) end their thinking with this and then write
 * the reply without calling `roll`.
 */
const ROLL_INTENT =
  /\b(let me roll|let's roll|i'?ll roll|i will roll|i need to roll|i should roll|i'?m going to roll|time to roll|roll for (this|it|that)|roll to (see|determine|decide|check))\b/gi;
const NO_ROLL = /\b(no roll|not roll|don'?t (need to )?roll|without (a )?roll)\b/gi;

/** Does the end of this thinking commit to a roll it has not taken back? */
export function thinkingPlansRoll(reasoning: string): boolean {
  const tail = reasoning.slice(-800);
  const last = (re: RegExp) => {
    let at = -1;
    for (const m of tail.matchAll(re)) at = m.index ?? at;
    return at;
  };
  const plan = last(ROLL_INTENT);
  return plan >= 0 && plan > last(NO_ROLL);
}

const ROLL_NUDGE =
  "(Game Master note: you decided this needs a roll. Call the roll tool now with the stakes you set, then narrate the result.)";

/**
 * Sampled models sometimes think a Turn through and then stop without a word
 * for the player (seen on DeepSeek V4 Flash through OpenRouter).
 */
const REPLY_NUDGE =
  "(Game Master note: your last answer ended before you wrote anything to the player. Write your reply to the player now.)";

function hostedSession(
  opts: HostedAgentOptions,
  create: SessionCreateOptions,
  sandbox: Awaited<ReturnType<typeof createSandbox>>,
): AgentSession {
  const handlers = new Set<(e: AgentSessionEvent) => void>();
  const emit = (e: AgentSessionEvent) => {
    for (const h of handlers) h(e);
  };
  const system = playProviderSystemPrompt(create.systemPrompt, create.contextFiles);
  const playTools = create.toolNames.length > 0 ? create.toolNames : [...PLAY_TOOL_NAMES];
  // the schemas the model sees stay fixed across passes so the engine keeps its
  // prompt cache; runTool refuses whatever the current pass may not call
  const offeredTools = [...new Set([...(create.offeredToolNames ?? []), ...playTools])];
  opts.onPromptBreakdown?.(promptBreakdown(create, offeredTools));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const proseFilter = createLocalProseFilter();
  let messages: ChatMessage[] = (create.seedMessages ?? []).map((m) =>
    m.role === "assistant"
      ? { role: "assistant", content: m.content }
      : // a mid-conversation system row breaks Qwen's template; OMP sends it as a user turn too
        { role: "user", content: m.content },
  );
  let current: AbortController | undefined;
  let lastUsage: number | undefined;
  const sessionId = `nq-${crypto.randomUUID()}`;
  /** Prose of the reply streaming now, for a Stop that lands mid-reply. */
  let streamed = "";
  /** This prompt's thinking across every round, which the Scratch shows whole. */
  let turnThinking = "";
  /**
   * Where the last prompt that failed or stopped put its player message. The
   * player's words stay in history so the next Turn knows what they asked;
   * a retry of the very same text replaces that attempt instead.
   */
  let unfinished: { at: number; text: string } | undefined;

  const complete = async (
    tools: readonly string[],
    /** The thinking prefill that opens this call, if any. */
    prefill: string | undefined,
    signal: AbortSignal,
    holdForRoll?: (reasoning: string) => boolean,
  ): Promise<Completion> => {
    const effort = qwenReasoningEffort(opts.reasoning?.());
    let body: unknown =
      opts.dialect === "openai"
        ? {
            messages: [
              { role: "system", content: system },
              ...withFirstTurnNote(messages, firstTurnNote(opts.modelId)).map((m) =>
                // OpenRouter takes earlier thinking back as `reasoning`, which keeps tool rounds coherent
                m.role === "assistant" && m.reasoning_content
                  ? (({ reasoning_content, ...rest }) => ({ ...rest, reasoning: reasoning_content }))(m)
                  : m,
              ),
            ],
            tools: toolSpecs(tools),
            stream: true,
            max_tokens: maxTokensOf(opts.maxTokens),
            reasoning: { effort: effort === "xhigh" ? "high" : effort },
            // keeps a conversation on one provider, so its long prompt stays cached
            session_id: sessionId,
          }
        : {
            model: opts.model ?? "qwen",
            stream: true,
            stream_options: { include_usage: true },
            max_completion_tokens: maxTokensOf(opts.maxTokens),
            preserve_thinking: true,
            // without an effort Qwen3.8's template thinks at xhigh on every call;
            // the kwarg reaches the template directly, the field is llama-server's route to it
            chat_template_kwargs: { preserve_thinking: true, reasoning_effort: effort },
            enable_thinking: true,
            reasoning_effort: effort,
            reasoning_budget_message: QWEN_BUDGET_STOP_MESSAGE,
            ...(opts.reasoningBudgetTokens !== undefined
              ? { reasoning_budget_tokens: opts.reasoningBudgetTokens }
              : {}),
            reasoning_control: true,
            messages: [{ role: "system", content: system }, ...messages],
            tools: toolSpecs(tools),
          };
    // the thinking prefill continues an assistant turn, which only our llama-server supports
    if (prefill !== undefined && opts.dialect !== "openai") {
      body = prefillLocalThinking(body, prefill);
    }
    const payload = JSON.stringify(body);

    const deadline = Date.now() + (opts.wakeBudgetMs ?? DEFAULT_WAKE_BUDGET_MS);
    // a cold worker can take minutes to answer; that wait is not a stall
    let heard = false;
    const heartbeat = setInterval(() => {
      if (!heard) emit({ type: "debug", payload: { waiting: "Game Master worker" } });
    }, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    try {
      return await callWithRetry(
        payload,
        signal,
        deadline,
        () => {
          heard = true;
        },
        holdForRoll,
      );
    } finally {
      clearInterval(heartbeat);
    }
  };

  const callWithRetry = async (
    payload: string,
    signal: AbortSignal,
    deadline: number,
    onFirstChunk: () => void,
    holdForRoll?: (reasoning: string) => boolean,
  ): Promise<Completion> => {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new AbortedError();
      let res: Response;
      try {
        res = await opts.transport("/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: payload,
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw new AbortedError();
        const waking = err instanceof RelayError ? WAKING_STATUS.has(err.status) : true;
        if (waking && Date.now() < deadline) {
          await sleep(Math.min(2_000 * 2 ** attempt, 15_000));
          continue;
        }
        throw err;
      }
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Game Master answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }
      return readCompletion(res.body, signal, onFirstChunk, holdForRoll);
    }
  };

  const readCompletion = async (
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    onFirstChunk: () => void,
    holdForRoll?: (reasoning: string) => boolean,
  ): Promise<Completion> => {
    const out: Completion = { content: "", reasoning: "", toolCalls: [] };
    // thinking from earlier rounds (before a roll, say) stays on the Scratch
    const earlier = turnThinking;
    const partial = new Map<number, ToolCall>();
    let textStarted = false;
    const dec = new TextDecoder();
    let buffered = "";
    const reader = body.getReader();
    const onAbort = () => void reader.cancel().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += dec.decode(value, { stream: true });
        let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end).trim();
          buffered = buffered.slice(end + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string | null;
                reasoning_content?: string | null;
                /** OpenRouter: the same thinking, as a string and as detail blocks */
                reasoning?: string | null;
                reasoning_details?: Array<{ type?: string; text?: string; summary?: string }>;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
              cost?: number;
            };
            error?: { message?: string };
          };
          if (chunk.error) throw new Error(chunk.error.message ?? "Game Master error");
          if (chunk.usage) {
            out.usage =
              (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0);
            opts.onUsage?.({
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined
                ? { cachedTokens: chunk.usage.prompt_tokens_details.cached_tokens }
                : {}),
              ...(typeof chunk.usage.cost === "number" ? { cost: chunk.usage.cost } : {}),
            });
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          onFirstChunk();
          if (choice.finish_reason === "error") throw new Error("Game Master stream failed");
          const delta = choice.delta ?? {};
          const thought =
            delta.reasoning_content ||
            delta.reasoning ||
            (delta.reasoning_details ?? [])
              .map((d) => d.text ?? d.summary ?? "")
              .join("");
          if (thought) {
            const lead = earlier && !out.reasoning ? "\n\n" : "";
            out.reasoning += thought;
            turnThinking = earlier ? `${earlier}\n\n${out.reasoning}` : out.reasoning;
            emit({ type: "thinking_delta", text: lead + thought });
          }
          // hosted models often open with blank lines, which the book would keep
          const said = out.content ? delta.content : delta.content?.trimStart();
          if (said) {
            delta.content = said;
            if (!textStarted) {
              // the reply is starting: hold it if the thinking planned a roll that never came
              if (partial.size === 0 && holdForRoll?.(out.reasoning)) {
                await reader.cancel().catch(() => {});
                throw new RollSkipped();
              }
              textStarted = true;
              if (out.reasoning) {
                emit({ type: "thinking_delta", text: turnThinking, snapshot: true });
              }
              proseFilter.reset();
              emit({ type: "prose_reset" });
            }
            out.content += delta.content;
            streamed = out.content;
            const shown = proseFilter.push(delta.content);
            if (shown) emit({ type: "prose_delta", text: shown });
          }
          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? 0;
            const call = partial.get(index) ?? {
              id: tc.id ?? `call_${index}`,
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
            if (tc.id) call.id = tc.id;
            if (tc.function?.name) call.function.name += tc.function.name;
            if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
            partial.set(index, call);
          }
        }
      }
    } catch (err) {
      if (signal.aborted) throw new AbortedError();
      throw err;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw new AbortedError();
    if (!textStarted && out.reasoning) {
      emit({ type: "thinking_delta", text: turnThinking, snapshot: true });
    }
    out.toolCalls = [...partial.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    return out;
  };

  return {
    id: `hosted:${create.cwd}`,
    async prompt(text, promptOpts): Promise<AgentPromptResult> {
      const hidden = promptOpts?.hidden === true;
      const tools = promptOpts?.toolNames ?? playTools;
      const schemas = tools.every((name) => offeredTools.includes(name)) ? offeredTools : tools;
      if (!hidden && unfinished && unfinished.text === text) {
        // the same words again (Retry, or the Play Loop's own retry): drop the failed attempt
        messages = messages.slice(0, unfinished.at);
      }
      unfinished = undefined;
      const before = messages;
      const ac = new AbortController();
      current = ac;
      const onOuterAbort = () => ac.abort();
      promptOpts?.signal?.addEventListener("abort", onOuterAbort, { once: true });
      if (promptOpts?.signal?.aborted) ac.abort();
      messages = [...messages, { role: "user", content: text }];
      streamed = "";
      turnThinking = "";
      // a planned roll the model skipped gets one reminder per prompt, never kept in history
      let rolled = false;
      let nudge: ChatMessage | undefined;
      let replyNudge: ChatMessage | undefined;
      const holdForRoll =
        !hidden && tools.includes("roll")
          ? (reasoning: string) => !rolled && !nudge && thinkingPlansRoll(reasoning)
          : undefined;
      try {
        for (let round = 0; ; round++) {
          if (round >= (opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS)) {
            throw new Error("Game Master kept calling tools without answering");
          }
          // only the opening of a play prompt starts a fresh thinking block
          let reply: Completion;
          try {
            const prefill = !hidden && round === 0 ? (promptOpts?.thinkingOpener ?? opts.thinkingOpener ?? "") : undefined;
            reply = await complete(schemas, prefill, ac.signal, holdForRoll);
          } catch (err) {
            if (!(err instanceof RollSkipped)) throw err;
            nudge = { role: "user", content: ROLL_NUDGE };
            messages = [...messages, nudge];
            emit({ type: "debug", payload: { rollReminder: true } });
            continue;
          }
          if (reply.usage !== undefined) lastUsage = reply.usage;
          if (reply.toolCalls.length === 0 && !reply.content.trim() && !hidden && !replyNudge) {
            // it thought and then ended without replying: ask once for the reply
            replyNudge = { role: "user", content: REPLY_NUDGE };
            messages = [...messages, replyNudge];
            emit({ type: "debug", payload: { replyReminder: true } });
            continue;
          }
          if (reply.toolCalls.length === 0) {
            messages = [
              ...messages,
              {
                role: "assistant",
                content: reply.content,
                ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
              },
            ];
            const prose = stripTrailingInternalNotes(
              stripLeadingLocalAnswerLabel(reply.content),
            );
            return { prose };
          }
          messages = [
            ...messages,
            {
              role: "assistant",
              content: reply.content,
              ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
              tool_calls: reply.toolCalls,
            },
          ];
          proseFilter.reset();
          emit({ type: "prose_reset" });
          for (const call of reply.toolCalls) {
            let args: Record<string, unknown> = {};
            let badArgs = false;
            try {
              const parsed = JSON.parse(call.function.arguments || "{}");
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
              else badArgs = true;
            } catch {
              badArgs = true;
            }
            if (call.function.name === "roll") rolled = true;
            const intent = typeof args.i === "string" ? args.i.trim() : "";
            emit({
              type: "tool_call",
              name: call.function.name,
              args,
              toolCallId: call.id,
              ...(intent ? { intent } : {}),
            });
            const result = badArgs
              ? { text: "Tool arguments were not valid JSON.", isError: true }
              : await runTool(sandbox, tools, call.function.name, args);
            emit({
              type: "tool_result",
              name: call.function.name,
              result: {
                content: [{ type: "text", text: result.text }],
                ...(result.isError ? { isError: true } : {}),
              },
              isError: result.isError,
              toolCallId: call.id,
            });
            messages = [...messages, { role: "tool", content: result.text, tool_call_id: call.id }];
            if (ac.signal.aborted) throw new AbortedError();
          }
        }
      } catch (err) {
        const stopped = err instanceof AbortedError || ac.signal.aborted;
        if (!hidden) {
          // keep the player's words (and what they saw, after a Stop) so the
          // next prompt knows what was asked, as OMP's journal does
          unfinished = { at: before.length, text };
          if (stopped && streamed) {
            messages = [...messages, { role: "assistant", content: streamed }];
          }
        }
        if (stopped) return { prose: "", aborted: true, error: "aborted" };
        return { prose: "", error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (nudge || replyNudge) messages = messages.filter((m) => m !== nudge && m !== replyNudge);
        if (hidden) messages = before;
        promptOpts?.signal?.removeEventListener("abort", onOuterAbort);
        if (current === ac) current = undefined;
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    abort() {
      current?.abort();
    },
    async end() {
      current?.abort();
      handlers.clear();
    },
    contextTokens() {
      return lastUsage;
    },
  };
}

function maxTokensOf(value: number | (() => number) | undefined): number {
  return (typeof value === "function" ? value() : value) ?? DEFAULT_MAX_TOKENS;
}
