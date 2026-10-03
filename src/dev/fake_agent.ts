import type {
  AgentPromptResult,
  AgentSession,
  AgentPromptOptions,
  AgentSessionEvent,
  AgentSessionFactory,
  SessionCreateOptions,
} from "../play/types.ts";

export type FakePromptHandler = (args: {
  text: string;
  hidden: boolean;
  sessionId: string;
  signal?: AbortSignal;
  session: FakeAgentSession;
}) => Promise<AgentPromptResult> | AgentPromptResult;

export type FakeAgentFactoryOptions = {
  /** Default prose when no handler matches. */
  defaultProse?: string;
  /** Default `/btw` side-channel prose. */
  ephemeralProse?: string;
  onEphemeral?: FakePromptHandler;
  onCreate?: (
    opts: SessionCreateOptions,
    session: FakeAgentSession,
  ) => unknown;
  onPrompt?: FakePromptHandler;
  /** Scripted queue of results (shifted per prompt). */
  script?: Array<AgentPromptResult | FakePromptHandler>;
  /** If true, continueRecent returns last created session. */
  resume?: boolean;
  /** OMP-style session occupancy for the leaf gauge. */
  contextTokens?: number;
};

export class FakeAgentSession implements AgentSession {
  readonly id: string;
  readonly createOpts: SessionCreateOptions;
  private handlers = new Set<(e: AgentSessionEvent) => void>();
  private aborted = false;
  private factory: FakeAgentFactory;
  ended = false;
  prompts: Array<{ text: string; hidden: boolean; toolNames?: string[] }> = [];
  activeToolNames: string[];
  ephemeralPrompts: string[] = [];

  constructor(id: string, opts: SessionCreateOptions, factory: FakeAgentFactory) {
    this.id = id;
    this.createOpts = opts;
    this.factory = factory;
    this.activeToolNames = [...opts.toolNames];
  }

  subscribe(handler: (event: AgentSessionEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: AgentSessionEvent): void {
    for (const h of this.handlers) h(event);
  }

  abort(): void {
    this.aborted = true;
  }

  async end(): Promise<void> {
    this.ended = true;
  }


  contextTokens(): number | undefined {
    const n = this.factory.opts.contextTokens;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  async prompt(
    text: string,
    opts?: AgentPromptOptions,
  ): Promise<AgentPromptResult> {
    const hidden = opts?.hidden ?? false;
    const previousToolNames = this.activeToolNames;
    if (opts?.toolNames) this.activeToolNames = [...opts.toolNames];
    this.prompts.push({
      text,
      hidden,
      ...(opts?.toolNames ? { toolNames: [...opts.toolNames] } : {}),
    });
    this.aborted = false;

    const onAbort = () => {
      this.aborted = true;
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (opts?.signal?.aborted) {
        return { prose: "", aborted: true, error: "aborted" };
      }

      const scripted = this.factory.nextScript();
      let result: AgentPromptResult;
      if (typeof scripted === "function") {
        result = await scripted({
          text,
          hidden,
          sessionId: this.id,
          signal: opts?.signal,
          session: this,
        });
      } else if (scripted) {
        result = scripted;
      } else if (this.factory.opts.onPrompt) {
        result = await this.factory.opts.onPrompt({
          text,
          hidden,
          sessionId: this.id,
          signal: opts?.signal,
          session: this,
        });
      } else {
        result = { prose: this.factory.opts.defaultProse ?? "The story continues." };
      }

      if (this.aborted || opts?.signal?.aborted) {
        return { prose: "", aborted: true, error: "aborted" };
      }

      if (result.prose && !hidden) {
        this.emit({ type: "prose_delta", text: result.prose });
      }
      return result;
    } finally {
      opts?.signal?.removeEventListener("abort", onAbort);
      this.activeToolNames = previousToolNames;
    }
  }

  async runEphemeralTurn(opts: {
    promptText: string;
    signal?: AbortSignal;
  }): Promise<AgentPromptResult> {
    this.ephemeralPrompts.push(opts.promptText);
    if (opts.signal?.aborted) {
      return { prose: "", aborted: true, error: "aborted" };
    }
    if (this.factory.opts.onEphemeral) {
      return this.factory.opts.onEphemeral({
        text: opts.promptText,
        hidden: true,
        sessionId: this.id,
        signal: opts.signal,
        session: this,
      });
    }
    return {
      prose:
        this.factory.opts.ephemeralProse ??
        "masterpiece, best quality, score_7, year 2025, safe, pov, pov hands, full body, 1girl, elf, lake, laughing. A red-haired elf stands at the lake edge and laughs toward the viewer.",
    };
  }

  async runLookupTurn(opts: {
    promptText: string;
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
  }): Promise<AgentPromptResult> {
    if (opts.onEvent) {
      opts.onEvent({
        type: "thinking_delta",
        text: "Looking up the people in this sitting.\n",
      });
      opts.onEvent({
        type: "tool_call",
        name: "read",
        args: { path: "player_sheet.md" },
        toolCallId: "illust-look-1",
      });
      opts.onEvent({
        type: "tool_result",
        name: "read",
        result: "ok",
        toolCallId: "illust-look-1",
      });
    }
    return this.runEphemeralTurn(opts);
  }
}

export class FakeAgentFactory implements AgentSessionFactory {
  readonly opts: FakeAgentFactoryOptions;
  readonly created: FakeAgentSession[] = [];
  private script: Array<AgentPromptResult | FakePromptHandler>;
  private seq = 0;
  private last: FakeAgentSession | null = null;

  constructor(opts: FakeAgentFactoryOptions = {}) {
    this.opts = opts;
    this.script = opts.script ? [...opts.script] : [];
  }

  nextScript(): AgentPromptResult | FakePromptHandler | undefined {
    return this.script.shift();
  }

  enqueue(...items: Array<AgentPromptResult | FakePromptHandler>): void {
    this.script.push(...items);
  }

  async create(opts: SessionCreateOptions): Promise<AgentSession> {
    this.seq += 1;
    const session = new FakeAgentSession(`fake-${this.seq}`, opts, this);
    this.created.push(session);
    this.last = session;
    await this.opts.onCreate?.(opts, session);
    return session;
  }

  async continueRecent(
    opts: Pick<
      SessionCreateOptions,
      "cwd" | "sessionsDir" | "systemPrompt" | "contextFiles" | "sandbox"
    >,
  ): Promise<AgentSession | null> {
    void opts;
    if (!this.opts.resume || !this.last) return null;
    // Simulate loading persisted session JSONL — ended in-process still resumes.
    this.last.ended = false;
    return this.last;
  }
}
