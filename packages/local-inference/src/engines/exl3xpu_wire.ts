/**
 * vLLM's side of the wire, as the Local Inference Host speaks it for
 * exl3xpu. NQ's Game Master talks Atomic's dialect; this rewrites the few
 * requests that differ, and emulates "Answer now".
 *
 * Atomic ends a reasoning block in place through its /control endpoint; vLLM
 * cannot change a request in flight. So the host keeps the reasoning streamed
 * so far, and "Answer now" aborts the request and resends it with that thought
 * closed in the prompt (the prefix cache makes the resend cheap); the answer
 * then streams into the same response the Game Master is already reading.
 * Events are forwarded whole, so the switch never splits one.
 */
import { EXL3_FAMILIES } from "./exl3_model.ts";
import type { ReasoningEnd } from "./engine.ts";

/**
 * Rewrites one chat-completions body NQ built for Atomic into vLLM's form:
 *
 * - NQ's thinking prefill (`continue_final_message: "reasoning_content"` after a
 *   trailing assistant row) becomes `chat_template_kwargs.nq_prefill`, the
 *   family's open-thought marker plus the text, which the template hook emits
 *   after the generation prompt;
 * - the reasoning budget, a server flag on Atomic, becomes the request's
 *   `thinking_token_budget`.
 */
export function translateExl3Request(
  body: Record<string, unknown>,
  opts: { architecture: string; reasoningTokens: number; speculative: boolean },
): { body: Record<string, unknown>; prefill?: string } {
  const family = EXL3_FAMILIES[opts.architecture];
  if (!family) return { body };
  // Atomic's switch for its /control endpoint; exl3xpu ends reasoning in the host
  const { reasoning_control: _atomicControl, ...rest } = body;
  const next: Record<string, unknown> = { ...rest };
  if (opts.speculative) {
    // vLLM rejects the whole request for these while a drafter is loaded
    delete next.min_p;
    delete next.logit_bias;
  }
  const kwargs = {
    ...((body.chat_template_kwargs as Record<string, unknown> | undefined) ?? {}),
  };
  let prefill: string | undefined;
  const messages = Array.isArray(body.messages) ? [...body.messages] : undefined;
  const last = messages?.at(-1) as Record<string, unknown> | undefined;
  if (
    body.continue_final_message === "reasoning_content" &&
    messages &&
    last?.role === "assistant" &&
    typeof last.reasoning_content === "string"
  ) {
    messages.pop();
    prefill = last.reasoning_content;
    next.messages = messages;
    next.add_generation_prompt = true;
    delete next.continue_final_message;
    kwargs.enable_thinking = true;
    kwargs.nq_prefill = `${family.thinkingOpen}${prefill}`;
  }
  if (Object.keys(kwargs).length > 0) next.chat_template_kwargs = kwargs;
  if (opts.reasoningTokens >= 0 && next.thinking_token_budget === undefined) {
    next.thinking_token_budget = opts.reasoningTokens;
  }
  return { body: next, ...(prefill !== undefined ? { prefill } : {}) };
}

/**
 * Caps the request's output budget at the room its prompt leaves in the
 * context. The Game Master asks for a generous ceiling (32768 from OMP's model
 * metadata); Atomic just stops when the context fills, but vLLM rejects any
 * request whose prompt plus `max_tokens` exceeds the context. vLLM's
 * /tokenize renders the prompt with the same template, tools and prefill.
 */
export async function fitExl3MaxTokens(
  engine: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const keys = ["max_tokens", "max_completion_tokens"].filter(
    (key) => typeof body[key] === "number",
  );
  if (keys.length === 0) return body;
  const requested = Math.min(...keys.map((key) => body[key] as number));
  try {
    const response = await fetch(`${engine}/tokenize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: body.model,
        messages: body.messages,
        ...(body.tools ? { tools: body.tools } : {}),
        add_generation_prompt: body.add_generation_prompt !== false,
        continue_final_message: body.continue_final_message === true,
        ...(body.chat_template_kwargs ? { chat_template_kwargs: body.chat_template_kwargs } : {}),
      }),
    });
    if (!response.ok) throw new Error(`tokenize returned ${response.status}`);
    const { count, max_model_len: limit } = (await response.json()) as {
      count: number;
      max_model_len: number;
    };
    const room = limit - count;
    // a prompt that fills the context gets vLLM's own error
    if (room <= 0 || requested <= room) return body;
    return { ...body, ...Object.fromEntries(keys.map((key) => [key, room])) };
  } catch {
    // without a count, leave the budget to vLLM: it defaults to the room left
    const next = { ...body };
    for (const key of keys) delete next[key];
    return next;
  }
}

/**
 * The body that resumes a request after "Answer now": the thought so far
 * (prefill plus what streamed), closed, so the model writes its answer next.
 */
function closeExl3Thought(
  body: Record<string, unknown>,
  opts: { architecture: string; prefill: string; reasoning: string },
): Record<string, unknown> {
  const family = EXL3_FAMILIES[opts.architecture]!;
  const kwargs = {
    ...((body.chat_template_kwargs as Record<string, unknown> | undefined) ?? {}),
    enable_thinking: true,
    nq_prefill: `${family.thinkingOpen}${opts.prefill}${opts.reasoning}${family.thinkingClose}`,
  };
  const { thinking_token_budget: _budget, ...rest } = body;
  return { ...rest, chat_template_kwargs: kwargs };
}

export function streamExl3Completion(opts: {
  target: URL;
  headers: Headers;
  body: Record<string, unknown>;
  architecture: string;
  /** The thinking prefill the request opened with, part of the thought to close. */
  prefill: string;
  first: Response;
  signal: AbortSignal;
  /** Aborts the first upstream request. */
  abortFirst: () => void;
  /** Registers the "Answer now" handler while the stream can still take it. */
  onReasoningEnd: (end: ReasoningEnd | undefined) => void;
  onDone: () => void;
}): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> = opts.first.body!.getReader();
  let buffered = "";
  let reasoning = "";
  let answering = false;
  let resume: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    opts.onReasoningEnd(undefined);
    opts.onDone();
  };

  const end: ReasoningEnd = async () => {
    if (answering) {
      return { success: false, message: "The Game Master is already answering." };
    }
    if (resume) return { success: false, message: "Reasoning is already ending." };
    const closed = closeExl3Thought(opts.body, {
      architecture: opts.architecture,
      prefill: opts.prefill,
      reasoning,
    });
    resume = (async () => {
      // the closed thought lengthens the prompt, so the output budget shrinks with it
      const body = await fitExl3MaxTokens(opts.target.origin, closed);
      const response = await fetch(opts.target, {
        method: "POST",
        headers: opts.headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`exl3xpu returned HTTP ${response.status} resuming the answer.`);
      }
      return response.body.getReader();
    })();
    // the handler is spent once the thought is closed
    opts.onReasoningEnd(undefined);
    opts.abortFirst();
    try {
      await resume;
      return { success: true };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  opts.onReasoningEnd(end);

  /** Tracks what an SSE event carried; true when the answer (or a tool call) has begun. */
  const note = (event: string) => {
    for (const line of event.split("\n")) {
      const payload = line.replace(/^data:\s*/, "").trim();
      if (!line.startsWith("data:") || !payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: Record<string, unknown> }>;
        };
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          const thought = delta.reasoning ?? delta.reasoning_content;
          if (typeof thought === "string") reasoning += thought;
          if (
            (typeof delta.content === "string" && delta.content.length > 0) ||
            (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
          ) {
            if (!answering) {
              answering = true;
              opts.onReasoningEnd(undefined);
            }
          }
        }
      } catch {
        // not JSON: forwarded untouched
      }
    }
  };

  let switched = false;
  /** Moves onto the resumed request; false when it could not start. */
  const switchToResume = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<boolean> => {
    buffered = "";
    try {
      reader = await resume!;
    } catch (error) {
      finish();
      controller.error(error);
      return false;
    }
    switched = true;
    return true;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (error) {
          if (!resume || switched) {
            finish();
            controller.error(error);
            return;
          }
          // the first request was aborted for "Answer now": continue on the resumed one
          if (!(await switchToResume(controller))) return;
          continue;
        }
        if (resume && !switched) {
          // after "Answer now" the first request's leftovers are not part of the closed thought
          if (next.done && !(await switchToResume(controller))) return;
          continue;
        }
        if (next.done) {
          buffered += decoder.decode();
          if (buffered) controller.enqueue(encoder.encode(buffered));
          buffered = "";
          finish();
          controller.close();
          return;
        }
        buffered += decoder.decode(next.value, { stream: true });
        let boundary: number;
        let emitted = false;
        while ((boundary = buffered.indexOf("\n\n")) >= 0) {
          const event = buffered.slice(0, boundary + 2);
          buffered = buffered.slice(boundary + 2);
          note(event);
          controller.enqueue(encoder.encode(event));
          emitted = true;
        }
        if (emitted) return;
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => {});
    },
  });
}
