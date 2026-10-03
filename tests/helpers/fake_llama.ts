/**
 * A scripted llama-server: the one thing the hosted tests fake. Everything
 * above it — the real seal worker, the Cloudflare relay, the browser seal
 * client, the hosted agent, the Play Loop and the Campaign on disk — runs for
 * real against it.
 *
 * Each `/v1/chat/completions` call runs one script step, which streams OpenAI
 * chunks the way Atomic's llama-server does: `reasoning_content` deltas, then
 * `content` deltas or `tool_calls`.
 */

export type LlamaMessage = {
  role: string;
  content?: unknown;
  reasoning_content?: string;
  /** OpenRouter's name for earlier thinking passed back */
  reasoning?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export type LlamaCall = {
  /** 1-based across the server's life. */
  readonly index: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly messages: LlamaMessage[];
  /** Text of the latest user message. */
  readonly prompt: string;
  /** Tool results since the latest user message, oldest first. */
  readonly toolResults: Array<{ id: string; text: string }>;
  readonly toolNames: string[];
  think(text: string): void;
  say(text: string): void;
  tool(name: string, args: Record<string, unknown>): void;
  /** Fail mid-stream the way llama-server does: an `error` event, then the end. */
  error(message: string): void;
  /** Resolves when the caller hangs up. */
  aborted(): Promise<void>;
};

export type LlamaStep = (call: LlamaCall) => void | Promise<void>;

export function says(text: string): LlamaStep {
  return (call) => {
    call.think("Weighing the scene.");
    call.say(text);
  };
}

export type FakeLlama = {
  readonly url: string;
  readonly calls: LlamaCall[];
  /** Queue more steps; they run before `fallback`. */
  push(...steps: LlamaStep[]): void;
  stop(): void;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part ? String(part.text) : "",
      )
      .join("");
  }
  return "";
}

export function startFakeLlama(
  opts: {
    steps?: LlamaStep[];
    fallback?: LlamaStep;
    /**
     * "openrouter" streams thinking as OpenRouter does (`reasoning_details`)
     * and reports cached tokens and cost in usage.
     */
    dialect?: "llama" | "openrouter";
  } = {},
): FakeLlama {
  const queue = [...(opts.steps ?? [])];
  const fallback = opts.fallback ?? says("The tide turns.");
  const calls: LlamaCall[] = [];
  const enc = new TextEncoder();

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      const body = (await request.json()) as Record<string, unknown>;
      const messages = (body.messages ?? []) as LlamaMessage[];
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "user") {
          lastUser = i;
          break;
        }
      }
      const toolResults = messages
        .slice(lastUser + 1)
        .filter((m) => m.role === "tool")
        .map((m) => ({ id: m.tool_call_id ?? "", text: textOf(m.content) }));
      const toolNames = ((body.tools ?? []) as Array<{ function: { name: string } }>).map(
        (t) => t.function.name,
      );
      const id = `chatcmpl-fake-${calls.length + 1}`;
      const step = queue.shift() ?? fallback;

      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
        if (!open) return;
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`,
          ),
        );
      };
      let toolCount = 0;
      let first = true;
      const role = () => {
        const r = first ? { role: "assistant" } : {};
        first = false;
        return r;
      };
      let open = true;
      const hangUp = new Promise<void>((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => {
            open = false;
            resolve();
          },
          { once: true },
        );
      });
      const call: LlamaCall = {
        index: calls.length + 1,
        body,
        headers: request.headers,
        messages,
        prompt: lastUser >= 0 ? textOf(messages[lastUser]!.content) : "",
        toolResults,
        toolNames,
        think: (text) =>
          chunk(
            opts.dialect === "openrouter"
              ? { ...role(), reasoning_details: [{ type: "reasoning.text", text }] }
              : { ...role(), reasoning_content: text },
          ),
        say: (text) => chunk({ ...role(), content: text }),
        tool: (name, args) => {
          const index = toolCount++;
          const callId = `call_${calls.length}_${index}`;
          const json = JSON.stringify(args);
          const half = Math.floor(json.length / 2);
          // arguments arrive split across chunks, as llama-server streams them
          chunk({
            ...role(),
            tool_calls: [
              { index, id: callId, type: "function", function: { name, arguments: json.slice(0, half) } },
            ],
          });
          chunk({ tool_calls: [{ index, function: { arguments: json.slice(half) } }] });
        },
        error: (message) => {
          if (!open) return;
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { code: 500, message } })}\n\n`));
          controller.close();
          open = false;
        },
        aborted: () => hangUp,
      };
      calls.push(call);
      void (async () => {
        try {
          await step(call);
          chunk({}, toolCount > 0 ? "tool_calls" : "stop");
          if (open) {
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  choices: [],
                  usage:
                    opts.dialect === "openrouter"
                      ? {
                          prompt_tokens: 1200,
                          completion_tokens: 80,
                          total_tokens: 1280,
                          prompt_tokens_details: { cached_tokens: 1000 },
                          cost: 0.00031,
                        }
                      : { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 },
                })}\n\ndata: [DONE]\n\n`,
              ),
            );
            controller.close();
          }
        } catch (err) {
          if (open) controller.error(err);
        } finally {
          open = false;
        }
      })();
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    push: (...steps) => queue.push(...steps),
    stop: () => server.stop(true),
  };
}
