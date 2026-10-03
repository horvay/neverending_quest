import { createRepetitionWatcher } from "./repetition.ts";
import type { ScratchRecorder } from "./scratch_recorder.ts";
import type { AgentSession, FailReason, PlayConfig, PlayEvent } from "./types.ts";

/** What the runner needs from the Play Loop that owns it. */
export type PromptRunnerHost = {
  emit(event: PlayEvent): void;
  /** The live play session; replaced sessions are read fresh on every call. */
  session(): AgentSession | null;
  /** The loop's own config, which live settings change in place. */
  config: PlayConfig;
  scratch: ScratchRecorder;
  /** Clear Scratch for a fresh attempt, keeping the Turn's thinking opener. */
  resetScratchForTurn(thinking?: string): void;
};

/** One play prompt; `partial` is the visible prose when the player pressed Stop. */
export type PlayAttempt = { failReason?: FailReason; prose: string; partial?: string };

/**
 * Prompts the play session for one Turn's reply: streams prose to the player,
 * aborts after a stretch with no activity or when the Game Master starts
 * looping, retries such loops, and turns every way a prompt ends into a
 * FailReason. Owns the Turn's abort controller so Stop and close reach it.
 */
export class PromptRunner {
  /** Open from the start of a Turn until its prompt settles. */
  private turnAbort: AbortController | null = null;
  /** Why the open Turn was aborted on purpose; anything else is a timeout. */
  private abortReason: FailReason | null = null;
  /** Why the last attempt was judged to be looping, for the player-facing note. */
  private repetitionReason: string | undefined;

  constructor(private readonly host: PromptRunnerHost) {}

  /** Open a Turn's abort window before its first prompt, so Stop lands early. */
  arm(): void {
    this.turnAbort = new AbortController();
  }

  /** Stop the open Turn. False when no Turn is open to stop. */
  interrupt(): boolean {
    if (!this.turnAbort) return false;
    this.abortReason = "interrupt";
    this.turnAbort.abort();
    return true;
  }

  /** Abort the open Turn without a reason (close), so it settles as a timeout. */
  abort(): void {
    this.turnAbort?.abort();
  }

  disarm(): void {
    this.turnAbort = null;
  }

  /**
   * Runs a Turn, retrying when the Game Master falls into a repetition loop.
   * Sampling makes such a collapse partly a matter of luck, so a fresh attempt
   * often succeeds; when the Turn's own context is what provokes it, no number
   * of retries helps, so the attempts are capped and the best reply is kept.
   */
  async run(playerText: string, thinking?: string): Promise<PlayAttempt> {
    const configured = this.host.config.repetitionAttempts;
    const attempts = Number.isFinite(configured) ? Math.max(1, configured) : 3;
    let last: PlayAttempt = { prose: "" };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        // the watcher reads Scratch, so the looped attempt must not carry over
        this.host.resetScratchForTurn(thinking);
        this.host.scratch.emitLive();
      }
      last = await this.attempt(playerText, thinking);
      if (last.failReason !== "repetition") return last;
      const reason = this.repetitionReason ?? "repeated itself";
      if (attempt < attempts) {
        this.host.emit({
          type: "status",
          message: `Game Master ${reason}; retrying (${attempt + 1} of ${attempts}).`,
        });
        continue;
      }
      this.host.emit({
        type: "status",
        message: `Game Master ${reason}; gave up after ${attempts} attempts.`,
      });
    }
    return last;
  }

  private consumeAbortReason(): FailReason | null {
    const r = this.abortReason;
    this.abortReason = null;
    return r;
  }

  private async attempt(
    playerText: string,
    thinking?: string,
  ): Promise<PlayAttempt> {
    const { emit, config, scratch } = this.host;
    const session = this.host.session();
    if (!session) {
      return { failReason: "aborted", prose: "" };
    }
    const ac = this.turnAbort ?? new AbortController();
    this.turnAbort = ac;
    const timeoutTurn = () => {
      ac.abort();
      this.host.session()?.abort();
    };
    let inactivityTimer = setTimeout(timeoutTurn, config.turnTimeoutMs);
    const noteActivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(timeoutTurn, config.turnTimeoutMs);
    };

    const repetition = createRepetitionWatcher();
    this.repetitionReason = undefined;

    let failReason: FailReason | undefined;
    let prose = "";
    // What the player sees in the live draft; kept if they press Stop.
    let visible = "";

    try {
      const unsubDelta = session.subscribe((ev) => {
        noteActivity();
        scratch.ingest(ev);
        if (ev.type === "thinking_delta" && !ac.signal.aborted) {
          const verdict = repetition.push(scratch.thinking);
          if (verdict.repetitive) {
            // a decoder that has started repeating itself will not recover
            this.repetitionReason = verdict.reason;
            this.abortReason = "repetition";
            ac.abort();
            this.host.session()?.abort();
          }
        }
        scratch.ingestRoll(ev);
        if (ev.type === "prose_delta") {
          visible += ev.text;
          emit({ type: "prose_delta", text: ev.text });
        } else if (ev.type === "prose_reset") {
          visible = "";
          emit({ type: "prose_reset" });
        } else if (ev.type === "debug" && config.debug) {
          emit({ type: "agent_debug", event: ev.payload });
        } else if (ev.type === "error") {
          emit({ type: "error", message: ev.message });
        }
      });

      let result;
      try {
        result = await session.prompt(playerText, {
          signal: ac.signal,
          ...(thinking ? { thinkingOpener: thinking } : {}),
        });
      } finally {
        unsubDelta();
      }

      if (ac.signal.aborted) {
        failReason = this.consumeAbortReason() ?? "timeout";
      } else if (result.aborted) {
        failReason = "interrupt";
      } else if (result.error) {
        failReason = "agent_error";
        const errText = result.error.toLowerCase();
        const overflow =
          errText.includes("context") &&
          (errText.includes("overflow") ||
            errText.includes("too long") ||
            errText.includes("maximum"));
        emit({
          type: "error",
          message: overflow
            ? `Mid-Turn context overflow: ${result.error}`
            : result.error,
          reason: "agent_error",
        });
      } else if (!result.prose || result.prose.trim().length === 0) {
        failReason = "empty_prose";
      } else {
        prose = result.prose;
      }
    } catch (err) {
      if (ac.signal.aborted) {
        failReason = this.consumeAbortReason() ?? "timeout";
      } else {
        failReason = "agent_error";
        emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          reason: "agent_error",
        });
      }
    } finally {
      clearTimeout(inactivityTimer);
      this.turnAbort = null;
    }
    if (failReason === "interrupt" && visible.trim().length > 0) {
      return { failReason, prose, partial: visible.trimEnd() };
    }
    return { failReason, prose };
  }
}

/**
 * Stop keeps the prose the player already saw as the GM reply, so Continue
 * can finish it. Timeouts and repetition aborts still FAIL.
 */
export function settleStopped(attempt: PlayAttempt): {
  failReason?: FailReason;
  prose: string;
  stopped: boolean;
} {
  if (attempt.failReason === "interrupt" && attempt.partial) {
    return { prose: attempt.partial, stopped: true };
  }
  return { failReason: attempt.failReason, prose: attempt.prose, stopped: false };
}
