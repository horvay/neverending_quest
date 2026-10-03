import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  archiveDossier,
  stampAllDossierFrontmatter,
} from "../campaign/dossiers.ts";
import { CampaignError } from "../campaign/errors.ts";
import {
  createInspectDossier,
  inspectHash,
  saveInspectFile,
  type InspectSaveResult,
} from "../campaign/inspect.ts";
import {
  commitCampaign,
  commitParentOid,
  findFailCommitForTip,
  findPlayCommitForTip,
  findTurnCommit,
  rewindCampaign,
} from "../campaign/history.ts";
import {
  openCampaign,
  type OpenedCampaign,
} from "../campaign/open.ts";
import { ensureOpeningTranscript } from "../campaign/opening_transcript.ts";
import { SEED_MD, SESSIONS_DIR } from "../campaign/paths.ts";
import {
  defaultPlayState,
  loadPlayState,
  savePlayState,
} from "../campaign/play_state.ts";
import {
  appendScratchRecord,
  pruneScratchByTs,
  readScratch,
  upsertScratchRecord,
} from "../campaign/scratch.ts";
import {
  appendTranscriptRow,
  deleteLastTranscript,
  editTranscriptText,
  lastDeletableRange,
  listGmTurns,
  listHistorySnapshots,
  readTranscript,
  replaceTranscriptRowAt,
  transcriptDigest,
} from "../campaign/transcript.ts";
import type {
  PlayState,
  ScratchRecord,
  TranscriptRow,
} from "../campaign/types.ts";
import { buildContextPrime, PinOverflowError } from "./context.ts";
import {
  buildContinueInstruction,
  composeContinuedProse,
} from "./continue_prose.ts";
import {
  afterHygienePass,
  buildHygieneInstruction,
  hygieneDue,
} from "./hygiene.ts";
import {
  createSandbox,
  HYGIENE_TOOL_NAMES,
  PLAY_TOOL_NAMES,
  SESSION_TOOL_NAMES,
  type Sandbox,
} from "./sandbox.ts";
import { DEFAULT_LOCAL_THINKING_OPENER } from "./scratch_format.ts";
import { ScratchRecorder } from "./scratch_recorder.ts";
import { PromptRunner, settleStopped } from "./prompt_runner.ts";
import { IllustrationJob } from "./illustration_job.ts";
import { armLuck, rollWithLuck } from "./luck.ts";
import {
  planReplacementSeed,
  type SeedKind,
  type SeedMessage,
} from "./session_seeder.ts";
import { showCampaign } from "../campaign/show.ts";
import {
  assertIllustrationSlot,
  assertIllustrationTs,
  illustrationAbs,
  illustrationCandidateAbs,
} from "./illustration.ts";
import type {
  InspectLeaf,
  AgentSession,
  Illustrator,
  AgentSessionFactory,
  ContextPrime,
  FailReason,
  ManualHygieneMode,
  LivePlaySettings,
  PlayConfig,
  PlayEvent,
  PlayLoopState,
  TurnResult,
} from "./types.ts";
import { DEFAULT_PLAY_CONFIG, INSPECT_TARGETS } from "./types.ts";
import { isLlamaCppModel } from "../model_selector.ts";

export type PlayLoopOptions = {
  path?: string;
  factory: AgentSessionFactory;
  config?: Partial<PlayConfig>;
  /** Force estimated context size (tests). */
  estimateContextTokens?: () => number;
  onEvent?: (event: PlayEvent) => void;
  /** Injected clock. */
  now?: () => Date;
  /** Injected roll entropy. */
  random?: () => number;
  /** Paints Illustrations; without one, Illustration is unavailable. */
  illustrator?: Illustrator;
};

export class PlayLoop {
  private state: PlayLoopState = "closed";
  private opened: OpenedCampaign | null = null;
  private session: AgentSession | null = null;
  private playState: PlayState = defaultPlayState();
  private sandbox: Sandbox | null = null;
  private unsub: (() => void) | null = null;
  /** Set while a Memory Hygiene pass runs, so Stop can end it. */
  private hygieneAbort: AbortController | null = null;
  /** Whether the last Memory Hygiene pass ended because the player pressed Stop. */
  private hygieneStopped = false;
  private readonly factory: AgentSessionFactory;
  private readonly config: PlayConfig;
  private readonly estimateContextTokens?: () => number;
  private readonly onEvent?: (event: PlayEvent) => void;
  private readonly now: () => Date;
  private readonly random?: () => number;
  private readonly explicitPath?: string;
  /** True after Context prime on the current session. */
  private primedThisSession = false;
  private lastStampMs = 0;
  private usage: { used: number; ceiling: number } | undefined;
  /** Work started by a command that close() must let settle first. */
  private readonly inFlight = new Set<Promise<unknown>>();
  // Each of these owns one slice of a run's state and reaches the loop only
  // through the callbacks it is handed here.
  private readonly scratch = new ScratchRecorder({
    emit: (event) => this.emit(event),
    campaignRoot: () => this.opened?.path,
    onToolResult: () => void this.refreshContext(),
  });
  private readonly prompts: PromptRunner;
  private readonly illustration: IllustrationJob;

  constructor(opts: PlayLoopOptions) {
    this.factory = opts.factory;
    this.config = { ...DEFAULT_PLAY_CONFIG, ...opts.config };
    this.estimateContextTokens = opts.estimateContextTokens;
    this.onEvent = opts.onEvent;
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random;
    this.explicitPath = opts.path;
    this.prompts = new PromptRunner({
      emit: (event) => this.emit(event),
      session: () => this.session,
      config: this.config,
      scratch: this.scratch,
      resetScratchForTurn: (thinking) => this.resetScratchForTurn(thinking),
    });
    this.illustration = new IllustrationJob(
      {
        emit: (event) => this.emit(event),
        campaignPath: () => this.opened?.path,
        session: () => this.session,
        scratch: this.scratch,
        closed: () => this.state === "closed",
        claim: (action) => this.claimAuthoring(action),
        release: () => this.releaseAuthoring(),
        emitStoryReplaced: () => this.emitStoryReplaced(),
      },
      opts.illustrator,
    );
  }

  get loopState(): PlayLoopState {
    return this.state;
  }

  get campaignPath(): string {
    if (!this.opened) throw new Error("PlayLoop not open");
    return this.opened.path;
  }

  get currentPlayState(): PlayState {
    return { ...this.playState };
  }

  /**
   * Apply settings the player changed from the book. Idle only: a new Game
   * Master personality rebuilds the play session so the next Turn reads the
   * new system prompt; the rest take effect on their next use.
   */
  async applyLiveSettings(settings: LivePlaySettings): Promise<void> {
    this.assertIdleForAuthoring("change settings");
    const personalityChanged =
      "gmPersonality" in settings &&
      (settings.gmPersonality?.trim() || undefined) !==
        (this.config.gmPersonality?.trim() || undefined);
    // the loop owns this copy (spread in the constructor), so update it in place
    Object.assign(this.config, settings);
    if (personalityChanged) {
      await this.whileAuthoring(() => this.replacePlaySession("full"));
    }
    await this.refreshContext();
  }

  async setLuckArmed(armed: boolean): Promise<PlayState> {
    this.assertIdleForAuthoring("set Luck Points");
    const path = this.opened!.path;
    this.playState = armLuck(await loadPlayState(path), armed);
    await savePlayState(path, this.playState);
    return { ...this.playState };
  }

  get currentSession(): AgentSession | null {
    return this.session;
  }

  get hasPrimedSession(): boolean {
    return this.primedThisSession;
  }

  get campaignSandbox(): Sandbox | null {
    return this.sandbox;
  }

  async open(): Promise<OpenedCampaign> {
    if (this.state !== "closed") {
      throw new Error("PlayLoop already open");
    }
    const opened = await openCampaign(this.explicitPath);
    if (!opened.hasSeed) {
      const err = missingSeedError(opened.path);
      this.emit({ type: "error", message: err.message, reason: "missing_seed" });
      throw err;
    }
    this.opened = opened;
    this.playState = await loadPlayState(opened.path);
    const opening = await ensureOpeningTranscript(opened.path);
    if (opening.seeded) {
      await commitCampaign(opened.path, "opening");
    }
    this.sandbox = await createSandbox({
      campaignRoot: opened.path,
      random: this.random,
      resolveRoll: (n, naturalRoll) => this.resolveLuckRoll(n, naturalRoll),
    });

    const prime = await buildContextPrime(opened.path, this.config);
    const sessionsDir = path.join(opened.path, SESSIONS_DIR);
    let session: AgentSession | null = null;
    if (this.factory.continueRecent) {
      session = await this.factory.continueRecent({
        cwd: opened.path,
        sessionsDir,
        systemPrompt: prime.systemPrompt,
        contextFiles: prime.contextFiles,
        sandbox: this.sandbox ?? undefined,
        offeredToolNames: [...SESSION_TOOL_NAMES],
        transcriptDigest: transcriptDigest(opening.rows),
      });
    }
    if (session) {
      this.session = session;
      this.primedThisSession = false;
    } else if (opening.rows.some((row) => row.role === "player")) {
      await this.createReplacementSession("full");
    } else {
      await this.createPrimedSession(undefined, prime);
      await this.markSessionSynced();
    }
    this.attachSession();
    this.state = "idle";
    await this.refreshContext();
    return opened;
  }

  get contextUsage(): { used: number; ceiling: number } | undefined {
    return this.usage;
  }

  async refreshContext(): Promise<{ used: number; ceiling: number }> {
    const fromSession = this.session?.contextTokens?.();
    const used =
      this.estimateContextTokens?.() ??
      (typeof fromSession === "number" ? fromSession : undefined) ??
      this.usage?.used ??
      0;
    // Occupancy is the live OMP session (tools + pins + tail), never
    // pins+transcript.jsonl. Ceiling is NQ rebuild-compact only.
    this.usage = { used, ceiling: this.config.compactCeilingTokens };
    this.emit({ type: "context", used: this.usage.used, ceiling: this.usage.ceiling });
    return this.usage;
  }

  async close(): Promise<void> {
    this.prompts.abort();
    this.hygieneAbort?.abort();
    this.illustration.abandon();
    if (this.inFlight.size > 0) {
      this.session?.abort();
      // an aborted Turn still records its outcome; let it finish before the
      // folder is released, or it writes into a Campaign nobody holds
      await Promise.allSettled([...this.inFlight]);
    }
    this.prompts.disarm();
    this.detachSession();
    if (this.session) {
      await this.session.end();
      this.session = null;
    }
    this.state = "closed";
    // a pick or cancel that arrives after close sees no Campaign
    this.opened = null;
  }

  /**
   * Run one Turn. Empty/whitespace input becomes `(continue)`.
   * Rejects overlapping calls while busy (hard-busy). `thinking`, for a
   * llama.cpp model, is where the Game Master's reasoning starts this Turn.
   */
  turn(
    playerInput: string,
    opts?: { thinking?: string },
  ): Promise<TurnResult> {
    return this.track(this.runTurn(playerInput, opts));
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    const settle = () => this.inFlight.delete(work);
    work.then(settle, settle);
    return work;
  }

  private async runTurn(
    playerInput: string,
    opts?: { thinking?: string },
  ): Promise<TurnResult> {
    if (this.state === "closed" || !this.opened) {
      throw new Error("PlayLoop not open");
    }
    if (this.state !== "idle") {
      this.emit({
        type: "error",
        message: "Hard-busy: a Turn is already in progress",
        reason: "busy",
      });
      return this.turnFailed("busy");
    }
    if (!this.session) {
      throw new Error("PlayLoop not open");
    }

    const playerText =
      playerInput.trim().length === 0 ? "(continue)" : playerInput;
    this.state = "turning";
    this.resetScratchForTurn(opts?.thinking);
    this.prompts.arm();
    const playerRow = await appendTranscriptRow(this.opened.path, {
      role: "player",
      text: playerText,
      ts: this.stamp(),
    });
    this.emit({ type: "turn_started", playerText, ts: playerRow.ts });

    const { failReason, prose, stopped } = settleStopped(
      await this.prompts.run(playerText, opts?.thinking),
    );

    if (failReason) {
      const result = this.turnFailed(failReason);
      try {
        await this.commitFail();
      } finally {
        this.state = "idle";
        await this.refreshContext();
      }
      return result;
    }

    // SUCCESS
    const gmRow = await appendTranscriptRow(this.opened.path, {
      role: "gm",
      text: prose,
      ts: this.stamp(),
    });
    this.playState = {
      ...this.playState,
      success_turn_count: this.playState.success_turn_count + 1,
    };
    await this.saveSuccess(
      appendScratchRecord,
      gmRow.ts,
      this.playState.success_turn_count,
    );
    // a stopped reply leaves a torn message; it is replaced below instead
    if (!stopped) await this.markSessionSynced();
    this.announceSuccess({ prose, ts: gmRow.ts, stopped });
    await this.refreshContext();

    try {
      const compacted = await this.finishSuccess(
        `turn ${this.playState.success_turn_count}`,
      );
      // The aborted session holds a torn assistant message; re-prime from
      // the transcript so the next Turn sees the kept reply instead.
      if (stopped && !compacted) {
        try {
          await this.replacePlaySession("full");
        } catch {
          // replacePlaySession already surfaced the error
        }
      }
    } finally {
      this.state = "idle";
    }
    return this.turnSucceeded(prose, stopped);
  }

  /**
   * Store a SUCCESS reply's Scratch (a Continue rewrites the row's record in
   * place) and the play state. The reply is already on the transcript.
   */
  private async saveSuccess(
    store: typeof appendScratchRecord,
    ts: string,
    turn: number,
  ): Promise<void> {
    await store(this.opened!.path, { ts, turn, ...this.scratch.record() });
    await savePlayState(this.opened!.path, this.playState);
  }

  private announceSuccess(reply: {
    prose: string;
    ts: string;
    stopped: boolean;
    extend?: true;
  }): void {
    this.emit({
      type: "turn_ended",
      outcome: "success",
      prose: reply.prose,
      ts: reply.ts,
      ...(reply.extend ? { extend: true as const } : {}),
    });
    if (reply.stopped) this.emit({ type: "status", message: STOPPED_NOTE });
  }

  /**
   * The busy tail of a SUCCESS, after the player has the reply: Memory
   * Hygiene or rebuild-compaction, then the snapshot commit. Neither failure
   * undoes the Turn; both are reported. Returns whether rebuild-compaction
   * already replaced the play session.
   */
  private async finishSuccess(commitLabel: string): Promise<boolean> {
    let compacted = false;
    try {
      compacted = await this.afterSuccessBusyPath();
    } catch (err) {
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    await this.commitOrReport(commitLabel);
    return compacted;
  }

  private turnSucceeded(prose: string, stopped: boolean): TurnResult {
    return {
      outcome: "success",
      prose,
      playState: { ...this.playState },
      ...(stopped ? { stopped: true as const } : {}),
    };
  }

  private turnFailed(reason: FailReason, extend?: true): TurnResult {
    const result: TurnResult = {
      outcome: "fail",
      reason,
      playState: { ...this.playState },
    };
    this.emit({
      type: "turn_ended",
      outcome: "fail",
      reason,
      ...(extend ? { extend } : {}),
    });
    return result;
  }

  /**
   * Surgical Idle edit of any row's `text`. `ts` / `role` stay.
   * Commits and replaces the play session (do not continueRecent).
   */
  async editTranscript(ts: string, text: string): Promise<TranscriptRow> {
    return this.runAuthoring(
      "edit",
      { announce: false, commit: "edit" },
      (campaignPath) => editTranscriptText(campaignPath, ts, text),
    );
  }

  /**
   * HTTP accept path: lock authoring, validate turn, then run rewind+extend
   * without awaiting (202 = accepted, outcome on events).
   */
  async startContinue(turn: number): Promise<void> {
    await this.claimContinue(turn);
    void this.track(this.runContinueFromTurn(turn)).catch(async (err) => {
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Idle Continue on GM turn N (opening = 0). Rewind if that snapshot is
   * not the last GM turn, then a hidden GM Turn extends that same row.
   */
  async continueFromTurn(turn: number): Promise<TurnResult> {
    await this.claimContinue(turn);
    return this.track(this.runContinueFromTurn(turn));
  }

  /** Lock first (no await) so a second Continue cannot both pass Idle. */
  private async claimContinue(turn: number): Promise<void> {
    this.claimAuthoring("continue");
    try {
      await this.assertContinueTarget(turn);
      await this.emitStoryReplaced(true);
    } catch (err) {
      this.releaseAuthoring();
      throw err;
    }
  }

  private async assertContinueTarget(turn: number): Promise<void> {
    const rows = await readTranscript(this.opened!.path);
    const gmTurns = listGmTurns(rows);
    if (!gmTurns.some((entry) => entry.turn === turn)) {
      throw new CampaignError("not_found", `No GM turn ${turn}`);
    }
    const lastTurn = gmTurns[gmTurns.length - 1]!.turn;
    if (turn === lastTurn) return;
    const oid = await findTurnCommit(this.opened!.path, turn);
    if (!oid) {
      throw new CampaignError(
        "not_found",
        `No campaign snapshot for turn ${turn}`,
      );
    }
  }

  private async runContinueFromTurn(turn: number): Promise<TurnResult> {
    try {
      const rows = await readTranscript(this.opened!.path);
      const gmTurns = listGmTurns(rows);
      const lastTurn = gmTurns[gmTurns.length - 1]?.turn;
      if (turn !== lastTurn) {
        const oid = await findTurnCommit(this.opened!.path, turn);
        if (!oid) {
          throw new CampaignError(
            "not_found",
            `No campaign snapshot for turn ${turn}`,
          );
        }
        await rewindCampaign(this.opened!.path, oid);
        this.playState = await loadPlayState(this.opened!.path);
        await this.replacePlaySession("full");
        await this.emitStoryReplaced(true);
      }

      const afterRows = await readTranscript(this.opened!.path);
      const stubTurn = listGmTurns(afterRows).find((entry) => entry.turn === turn);
      if (!stubTurn) {
        throw new CampaignError("not_found", `No GM turn ${turn} after rewind`);
      }
      const stubRow = stubTurn.row;
      const stub = stubRow.text;

      this.state = "turning";
      this.resetScratchForTurn();
      this.emit({
        type: "turn_started",
        playerText: stub,
        ts: stubRow.ts,
        extend: true,
      });

      // Last assistant seed is already the stub. Do not send it again as
      // a player line — the model then treats Continue as a new GM turn.
      const { failReason, prose, stopped } = settleStopped(
        await this.prompts.run(buildContinueInstruction(stub)),
      );
      if (failReason) {
        const result = this.turnFailed(failReason, true);
        try {
          await this.commitFail();
          await this.replacePlaySession("full");
        } finally {
          await this.emitStoryReplaced();
        }
        return result;
      }

      const nextText = composeContinuedProse(stub, prose);
      const gmRow = await replaceTranscriptRowAt(
        this.opened!.path,
        stubTurn.index,
        nextText,
      );
      await this.saveSuccess(upsertScratchRecord, gmRow.ts, turn);
      this.announceSuccess({
        prose: nextText,
        ts: gmRow.ts,
        stopped,
        extend: true,
      });

      try {
        const compacted = await this.finishSuccess(`continue ${turn}`);
        // the session holds the Continue instruction and a bare suffix, not
        // the rewritten row; re-prime from the transcript
        try {
          if (!compacted) await this.replacePlaySession("full");
        } finally {
          await this.emitStoryReplaced();
        }
      } finally {
        this.state = "idle";
      }
      return this.turnSucceeded(nextText, stopped);
    } finally {
      if (
        this.state === "authoring" ||
        this.state === "turning" ||
        this.state === "hygiene"
      ) {
        this.state = "idle";
        await this.emitStoryReplaced();
      }
    }
  }

  /**
   * Idle delete of the last row, or the last player+GM pair.
   * A finished last Turn rewinds the Campaign tree to the snapshot
   * before that Turn, then replaces the play session.
   * A FAIL orphan player row rewinds the `fail` commit when one
   * exists; otherwise it still chops the transcript only.
   */
  async deleteTranscript(ts?: string): Promise<TranscriptRow[]> {
    this.assertIdleForAuthoring("delete");
    return this.whileAuthoring(() => this.deleteTranscriptLocked(ts, false));
  }

  /**
   * Rewind the latest Turn, then submit its player text again. A trailing
   * player message whose Turn failed is sent again the same way. With
   * `thinking` (the player's edit of that Turn's Scratch), the Game Master
   * continues its reasoning from the end of that text.
   */
  async startRetryTranscript(ts: string, thinking?: string): Promise<void> {
    const claim = await this.claimRetryTranscript(ts, thinking);
    void this.track(
      this.runRetryTranscript(ts, claim.playerText, claim.thinking),
    ).catch(async (err) => {
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      if (this.state !== "closed") this.state = "idle";
      await this.emitStoryReplaced();
    });
  }

  private async claimRetryTranscript(
    ts: string,
    thinking: string | undefined,
  ): Promise<{ playerText: string; thinking?: string }> {
    this.claimAuthoring("retry");
    try {
      const rows = await readTranscript(this.opened!.path);
      const range = lastDeletableRange(rows);
      const player = range?.deleted[0];
      const gm = range?.deleted[1];
      // the latest Turn, or a player message whose Turn failed without a reply
      const completed =
        range?.deleted.length === 2 && player?.role === "player" && gm?.role === "gm" && gm.ts === ts;
      const unanswered =
        range?.deleted.length === 1 && player?.role === "player" && player.ts === ts;
      if (!completed && !unanswered) {
        throw new CampaignError("not_last", "Retry the latest Turn only");
      }
      if (thinking === undefined) return { playerText: player!.text };
      if (!completed) {
        throw new CampaignError(
          "not_last",
          "Only a Game Master reply has Scratch to continue",
        );
      }
      if (!this.localThinkingOpener()) {
        throw new CampaignError(
          "bad_prompt",
          "Only a llama.cpp Game Master can continue edited Scratch",
        );
      }
      // the wire prefill trims too; Scratch must show what the model continued
      const opener = thinking.trim();
      if (!opener) {
        throw new CampaignError("bad_prompt", "Scratch to continue from is empty");
      }
      return { playerText: player!.text, thinking: opener };
    } catch (err) {
      this.state = "idle";
      throw err;
    }
  }

  private async runRetryTranscript(
    ts: string,
    playerText: string,
    thinking: string | undefined,
  ): Promise<void> {
    // The rewind restores the snapshot's Luck Points; a point the player armed
    // for this retry stays armed, or Retry would quietly undo their choice.
    const armed = this.playState.luck_armed;
    await this.deleteTranscriptLocked(ts, true);
    if (armed && !this.playState.luck_armed) {
      this.playState = armLuck(this.playState, true);
      await savePlayState(this.opened!.path, this.playState);
    }
    this.state = "idle";
    await this.turn(playerText, { thinking });
  }

  private async deleteTranscriptLocked(
    ts: string | undefined,
    busyAfter: boolean,
  ): Promise<TranscriptRow[]> {
    const campaignPath = this.opened!.path;
    const rows = await readTranscript(campaignPath);
    const range = lastDeletableRange(rows);
    if (!range) {
      throw new CampaignError("not_last", "Transcript is empty");
    }
    if (
      ts !== undefined &&
      !range.deleted.some((row) => row.ts === ts)
    ) {
      throw new CampaignError(
        "not_last",
        "Delete last row or last player+GM pair only",
      );
    }
    const rewindOid = await this.deleteRewindOid(rows, range.deleted);
    try {
      if (rewindOid) {
        await rewindCampaign(campaignPath, rewindOid);
        this.playState = await loadPlayState(campaignPath);
      } else {
        const deleted = await deleteLastTranscript(campaignPath, ts);
        await pruneScratchByTs(
          campaignPath,
          deleted.filter((row) => row.role === "gm").map((row) => row.ts),
        );
        await commitCampaign(campaignPath, "delete");
      }
      await this.replacePlaySession("full");
      return range.deleted;
    } finally {
      await this.emitStoryReplaced(busyAfter);
    }
  }

  /**
   * Parent of the newest play snapshot if that pair is what Delete drops,
   * or parent of the `fail` snapshot if the tail is a torn player row.
   */
  private async deleteRewindOid(
    rows: TranscriptRow[],
    deleted: TranscriptRow[],
  ): Promise<string | null> {
    if (deleted.length === 1 && deleted[0]?.role === "player") {
      const oid = await findFailCommitForTip(
        this.opened!.path,
        deleted[0].ts,
      );
      if (!oid) return null;
      return commitParentOid(this.opened!.path, oid);
    }
    if (deleted.length !== 2 || deleted[1]?.role !== "gm") return null;
    const last = listGmTurns(rows).at(-1);
    if (!last || last.row.ts !== deleted[1].ts) return null;
    if (last.turn <= 0) return null;
    const oid = await findPlayCommitForTip(this.opened!.path, last.row.ts);
    if (!oid) return null;
    return commitParentOid(this.opened!.path, oid);
  }

  /** Player row + any live FAIL writes. No-op when the tree matches HEAD. */
  private async commitFail(): Promise<void> {
    if (!this.opened) return;
    await this.commitOrReport("fail");
  }

  /** Commit a snapshot; a git failure is reported, not thrown. */
  private async commitOrReport(label: string): Promise<void> {
    try {
      await commitCampaign(this.opened!.path, label);
    } catch (err) {
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        reason: "git_failed",
      });
    }
  }

  /**
   * Idle Save of a writable Inspect leaf. Commits and replaces the
   * play session (full prime — do not compact).
   */
  async saveInspect(
    target: string,
    body: string,
    hash: string,
    slug?: string,
  ): Promise<InspectSaveResult> {
    return this.runAuthoring(
      "inspect",
      { announce: true, commit: "inspect" },
      (campaignPath) =>
        saveInspectFile({ path: campaignPath, target, slug, body, hash }),
    );
  }

  /**
   * Idle archive / unarchive of a dossier slug. Commits and replaces
   * the play session (full prime) so the catalog pin drops or returns.
   */
  async archiveDossier(
    slug: string,
    archive = true,
  ): Promise<{ slug: string; archived: boolean; moved: boolean }> {
    return this.runAuthoring(
      "archive",
      {
        announce: true,
        commit: (result) =>
          result.moved ? (archive ? "archive" : "unarchive") : null,
      },
      (campaignPath) => archiveDossier(campaignPath, slug, archive),
    );
  }

  /**
   * Idle create of a dossier slug. Never delete. Archive is the one
   * allowed path change. Commits and replaces the play session (full prime).
   */
  async createDossier(slug: string, body?: string): Promise<InspectSaveResult> {
    return this.runAuthoring(
      "inspect",
      { announce: true, commit: "dossier" },
      (campaignPath) => createInspectDossier({ path: campaignPath, slug, body }),
    );
  }

  /**
   * The Idle authoring template: lock, change the Campaign folder, commit,
   * re-prime the play session from disk (full, never compacted), and send
   * the story again. `announce` locks the surfaces' chrome before the change
   * and always unlocks it after; without it the story is re-sent only once
   * the change has landed. `commit` names the snapshot, or null to skip it.
   */
  private async runAuthoring<T>(
    action: string,
    opts: { announce: boolean; commit: string | ((result: T) => string | null) },
    mutate: (campaignPath: string) => Promise<T>,
  ): Promise<T> {
    this.assertIdleForAuthoring(action);
    return this.whileAuthoring(async () => {
      let changed = opts.announce;
      try {
        if (opts.announce) await this.emitStoryReplaced(true);
        const result = await mutate(this.opened!.path);
        changed = true;
        const label =
          typeof opts.commit === "string" ? opts.commit : opts.commit(result);
        if (label) await commitCampaign(this.opened!.path, label);
        await this.replacePlaySession("full");
        return result;
      } finally {
        if (changed) await this.emitStoryReplaced();
      }
    });
  }

  illustrationStatus(): Promise<{ ready: boolean; reason?: string }> {
    return this.illustration.status();
  }

  /**
   * Idle: rewrite the latest GM row into tags (unless a prompt is given),
   * paint four local variants. Stamp + commit happen on pick.
   */
  illustrate(opts?: { prompt?: string }): Promise<{ ts: string; prompt: string }> {
    return this.track(this.illustration.run(opts));
  }

  pickIllustration(slot: number): Promise<{ ts: string; prompt: string }> {
    return this.illustration.pick(slot);
  }

  cancelIllustration(): Promise<void> {
    return this.illustration.cancel();
  }

  /**
   * Eval/test hook: run Memory Hygiene without a play Turn.
   * Requires Idle. Restores Idle after. Does not commit (eval isolation).
   */
  async runHygienePass(mode: "light" | "heavy"): Promise<boolean> {
    this.assertIdleForEval("hygiene");
    try {
      return await this.runHygiene(mode);
    } finally {
      this.state = "idle";
    }
  }

  /**
   * Eval/test hook: heavy Memory Hygiene then rebuild-compaction.
   * Requires Idle. Restores Idle after. Does not commit (eval isolation).
   */
  async runRebuildCompaction(): Promise<boolean> {
    this.assertIdleForEval("rebuild-compaction");
    try {
      return await this.runHeavyHygieneAndCompact();
    } finally {
      this.state = "idle";
    }
  }

  /**
   * HTTP accept path: lock hygiene immediately, then run without awaiting
   * (202 = accepted, outcome on events).
   */
  async startHygiene(mode: ManualHygieneMode): Promise<void> {
    this.claimHygiene();
    void this.track(this.finishManualHygiene(mode)).catch((err) => {
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Idle Light / Heavy / Compact. Same PlayLoop path as automatic.
   * Commits on success. Manual does not reset the automatic clock.
   */
  async runManualHygiene(mode: ManualHygieneMode): Promise<boolean> {
    this.claimHygiene();
    return this.track(this.finishManualHygiene(mode));
  }

  /** Lock first (no await) so a second hygiene POST cannot both pass Idle. */
  private claimHygiene(): void {
    this.assertIdleForAuthoring("hygiene");
    this.state = "hygiene";
  }

  private async finishManualHygiene(mode: ManualHygieneMode): Promise<boolean> {
    try {
      const ok =
        mode === "compact" || mode === "fresh"
          ? await this.runHeavyHygieneAndCompact(mode)
          : await this.runHygiene(mode);
      if (ok) await this.commitOrReport(mode);
      return ok;
    } finally {
      if (this.state === "hygiene") this.state = "idle";
      await this.refreshContext();
    }
  }

  /** Abort the in-flight Turn or Memory Hygiene pass (Stop, SIGINT). */
  interrupt(): void {
    if (this.state === "hygiene" && this.hygieneAbort) {
      this.hygieneAbort.abort();
      this.session?.abort();
      return;
    }
    if (this.state !== "turning") return;
    if (this.prompts.interrupt()) this.session?.abort();
  }

  private stamp(): string {
    let ms = this.now().getTime();
    if (ms <= this.lastStampMs) ms = this.lastStampMs + 1;
    this.lastStampMs = ms;
    return new Date(ms).toISOString();
  }

  private async afterSuccessBusyPath(): Promise<boolean> {
    if (!this.opened || !this.session) return false;
    await stampAllDossierFrontmatter(this.opened.path);

    const contextTokens = (await this.refreshContext()).used;

    const compactDue = contextTokens >= this.config.compactCeilingTokens;
    const lightDue = hygieneDue(this.playState, this.config.hygieneN);

    if (compactDue) {
      const compacted = await this.runHeavyHygieneAndCompact();
      await this.refreshContext();
      return compacted;
    }
    if (lightDue) {
      await this.runHygiene("light");
      await this.refreshContext();
    }
    return false;
  }

  private async runHygiene(mode: "light" | "heavy"): Promise<boolean> {
    if (!this.opened || !this.session) return false;
    const session = this.session;
    this.state = "hygiene";
    this.scratch.reset();
    this.emit({ type: "hygiene_started", mode });
    this.emit({ type: "status", message: "Memory hygiene…" });
    this.scratch.emitLive();

    const rows = await readTranscript(this.opened.path);
    const fromLine = this.playState.last_hygiene_transcript_line ?? 0;
    const instruction = buildHygieneInstruction({
      mode,
      playState: this.playState,
      transcriptFromLine: fromLine,
      transcriptLineCount: rows.length,
    });

    let ok = false;
    let error: string | undefined;
    const abort = new AbortController();
    this.hygieneAbort = abort;
    const unsubscribe = session.subscribe((event) => {
      this.scratch.ingest(event);
    });
    try {
      const result = await session.prompt(instruction, {
        hidden: true,
        signal: abort.signal,
        toolNames: HYGIENE_TOOL_NAMES,
      });
      if (result.aborted || result.error) {
        ok = false;
        error = result.error ?? "hygiene aborted";
      } else {
        ok = true;
      }
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      unsubscribe();
      this.hygieneAbort = null;
    }
    this.hygieneStopped = abort.signal.aborted;
    if (this.hygieneStopped) error = HYGIENE_STOPPED;

    this.playState = afterHygienePass(this.playState, {
      mode,
      ok,
      at: this.now().toISOString(),
      error,
      transcriptLineCount: rows.length,
    });
    if (!ok) {
      this.emit(
        this.hygieneStopped
          ? { type: "status", message: HYGIENE_STOPPED_NOTE }
          : {
              type: "error",
              message: `Memory hygiene (${mode}) failed: ${error ?? "unknown"}`,
            },
      );
    }
    if (ok) await stampAllDossierFrontmatter(this.opened.path);
    await savePlayState(this.opened.path, this.playState);
    this.emit({ type: "hygiene_ended", mode, ok, error });
    return ok;
  }

  private async runHeavyHygieneAndCompact(
    kind: "compact" | "fresh" = "compact",
  ): Promise<boolean> {
    this.emit({ type: "compact_started" });
    const ok = await this.runHygiene("heavy");
    if (!ok && this.hygieneStopped) {
      this.emit({ type: "compact_ended", ok: false, error: HYGIENE_STOPPED });
      return false;
    }
    if (!ok) {
      this.emit({
        type: "compact_ended",
        ok: false,
        error: "heavy hygiene failed; aborting rebuild-compaction",
      });
      this.emit({
        type: "error",
        message: "Rebuild-compaction aborted: heavy Memory Hygiene failed",
      });
      return false;
    }

    try {
      await this.replacePlaySession(kind);
      this.emit({ type: "compact_ended", ok: true });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "compact_ended", ok: false, error: message });
      this.emit({ type: "error", message: `Rebuild-compaction failed: ${message}` });
      return false;
    }
  }

  private assertIdleForEval(action: string): void {
    if (this.state === "closed" || !this.opened || !this.session) {
      throw new Error("PlayLoop not open");
    }
    if (this.state !== "idle") {
      throw new Error(`PlayLoop must be idle to run ${action}`);
    }
  }

  /** Assert Idle, then lock authoring before any await so a rival cannot pass. */
  private claimAuthoring(action: string): void {
    this.assertIdleForAuthoring(action);
    this.state = "authoring";
  }

  /** Hold the authoring lock for `work`; the caller already checked Idle. */
  private async whileAuthoring<T>(work: () => Promise<T>): Promise<T> {
    this.state = "authoring";
    try {
      return await work();
    } finally {
      this.releaseAuthoring();
    }
  }

  /** Back to Idle unless something else (close, a Turn) took the state over. */
  private releaseAuthoring(): void {
    if (this.state === "authoring") this.state = "idle";
  }

  private assertIdleForAuthoring(action: string): void {
    if (this.state === "closed" || !this.opened) {
      throw new CampaignError("busy", "PlayLoop not open");
    }
    if (this.state !== "idle") {
      throw new CampaignError("busy", `PlayLoop must be idle to ${action}`);
    }
    if (!this.session) {
      throw new CampaignError("session_failed", "Play session is not available");
    }
  }

  private async replacePlaySession(kind: SeedKind): Promise<void> {
    if (!this.opened) {
      throw new CampaignError("session_failed", "PlayLoop not open");
    }
    this.detachSession();
    if (this.session) {
      await this.session.end();
      this.session = null;
    }
    try {
      await this.createReplacementSession(kind);
      this.attachSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // a session made before the failure (say, the sync stamp threw) is not kept
      const made = this.session as AgentSession | null;
      if (made) {
        await made.end().catch(() => {});
        this.session = null;
      }
      try {
        await this.createPrimedSession();
        this.attachSession();
      } catch {
        this.session = null;
      }
      this.emit({
        type: "error",
        message: `Session replace failed: ${message}`,
      });
      throw err instanceof CampaignError || err instanceof PinOverflowError
        ? err
        : new CampaignError("session_failed", message);
    }
  }

  private async createReplacementSession(kind: SeedKind): Promise<void> {
    await this.createSeededSession(kind);
    await this.markSessionSynced();
  }

  /**
   * Stamp the live journal as caught up with the transcript on disk, so a
   * restart resumes it. A journal left unstamped is rebuilt from the transcript.
   */
  private async markSessionSynced(): Promise<void> {
    this.session?.markTranscriptSync?.(
      transcriptDigest(await readTranscript(this.opened!.path)),
    );
  }

  private async createSeededSession(kind: SeedKind): Promise<void> {
    const { prime, seedMessages } = await planReplacementSeed(
      this.opened!.path,
      kind,
      this.config,
      (message) => this.emit({ type: "error", message }),
    );
    await this.createPrimedSession(seedMessages, prime);
  }

  /** Same tail `nq serve` puts on the kernel snapshot (default 20 rows). */
  async snapshotStory(): Promise<
    Array<{
      role: "player" | "gm";
      text: string;
      ts: string;
      turn?: number;
      illustration?: string;
      illustrationPrompt?: string;
    }>
  > {
    if (!this.opened) return [];
    const rows = await readTranscript(this.opened.path);
    const n = this.config.playTranscriptTailRows;
    const start = n >= rows.length ? 0 : rows.length - n;
    const turnByIndex = new Map(
      listGmTurns(rows).map((entry) => [entry.index, entry.turn]),
    );
    return rows.slice(start).map((row, i) => ({
      role: row.role,
      text: row.text,
      ts: row.ts,
      ...(row.role === "gm" && turnByIndex.has(start + i)
        ? { turn: turnByIndex.get(start + i) }
        : {}),
      ...(row.illustration ? { illustration: row.illustration } : {}),
      ...(row.illustrationPrompt
        ? { illustrationPrompt: row.illustrationPrompt }
        : {}),
    }));
  }

  /** Reachable Continue targets (turn + short GM prose). Same as GET /api/history. */
  async history(): Promise<Array<{ turn: number; prose: string }>> {
    if (!this.opened) {
      throw new CampaignError("busy", "PlayLoop not open");
    }
    return listHistorySnapshots(await readTranscript(this.opened.path));
  }

  /** An Inspect leaf (or one Dossier) as it is on disk now. */
  async inspect(target: string, slug?: string): Promise<InspectLeaf> {
    if (!this.opened) {
      throw new CampaignError("busy", "PlayLoop not open");
    }
    if (!INSPECT_TARGETS.has(target)) {
      throw new CampaignError("inspect_forbidden", `Cannot inspect ${target}`);
    }
    const leaf = await showCampaign({
      path: this.opened.path,
      target,
      dossierSlug: slug,
    });
    return { ...leaf, hash: inspectHash(leaf.text) };
  }

  /** Where a Turn's kept picture is, or one candidate sitting while painting. */
  illustrationFile(ts: string, slot?: number): string {
    if (!this.opened) {
      throw new CampaignError("busy", "PlayLoop not open");
    }
    const id = assertIllustrationTs(ts);
    return slot === undefined
      ? illustrationAbs(this.opened.path, id)
      : illustrationCandidateAbs(this.opened.path, id, assertIllustrationSlot(slot));
  }

  /** Joinable Scratch records. Same as GET /api/scratch. */
  async listScratch(): Promise<ScratchRecord[]> {
    if (!this.opened) {
      throw new CampaignError("busy", "PlayLoop not open");
    }
    return readScratch(this.opened.path);
  }

  private async emitStoryReplaced(busy = false): Promise<void> {
    this.emit({
      type: "story_replaced",
      story: await this.snapshotStory(),
      successTurnCount: this.playState.success_turn_count,
      ...(busy ? { busy: true as const } : {}),
    });
    await this.refreshContext();
  }

  private async createPrimedSession(
    seedMessages?: SeedMessage[],
    existingPrime?: ContextPrime,
  ): Promise<void> {
    if (!this.opened) throw new Error("not open");
    const prime =
      existingPrime ?? (await buildContextPrime(this.opened.path, this.config));
    const sessionsDir = path.join(this.opened.path, SESSIONS_DIR);
    this.session = await this.factory.create({
      cwd: this.opened.path,
      sessionsDir,
      systemPrompt: prime.systemPrompt,
      contextFiles: prime.contextFiles,
      toolNames: [...PLAY_TOOL_NAMES],
      offeredToolNames: [...SESSION_TOOL_NAMES],
      seedMessages,
      sandbox: this.sandbox ?? undefined,
      searchFullModel: this.config.searchFullModel,
      searchFullReasoning: this.config.searchFullReasoning,
    });
    this.primedThisSession = true;
  }

  private attachSession(): void {
    this.detachSession();
    if (!this.session) return;
    this.unsub = this.session.subscribe((ev) => {
      if (ev.type === "debug" && this.config.debug) {
        this.emit({ type: "agent_debug", event: ev.payload });
      }
    });
  }

  private detachSession(): void {
    this.unsub?.();
    this.unsub = null;
  }

  private resetScratchForTurn(thinking?: string): void {
    this.scratch.resetForTurn(thinking ?? this.localThinkingOpener());
  }

  private localThinkingOpener(): string | undefined {
    if (!isLlamaCppModel(this.config.model)) return undefined;
    return (
      this.config.localThinkingOpener?.trim() ||
      DEFAULT_LOCAL_THINKING_OPENER
    );
  }

  /** Rolls through the Luck Point ledger, persisting it before the value is used. */
  private async resolveLuckRoll(
    n: number,
    naturalRoll: () => number,
  ): Promise<number> {
    const previous = this.playState;
    const { value, next } = rollWithLuck(previous, n, naturalRoll);
    if (this.opened && next) {
      this.playState = next;
      try {
        await savePlayState(this.opened.path, next);
      } catch (error) {
        this.playState = previous;
        throw error;
      }
    }
    return value;
  }

  private emit(event: PlayEvent): void {
    this.onEvent?.(event);
    if (this.config.logPath) {
      try {
        const line = `${JSON.stringify({ ts: this.now().toISOString(), ...event })}\n`;
        void appendFile(this.config.logPath, line).catch(() => {
          // ignore log failures
        });
      } catch {
        // ignore
      }
    }
  }
}

export class MissingSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingSeedError";
  }
}

function missingSeedError(campaignPath: string): MissingSeedError {
  return new MissingSeedError(
    `Campaign missing required seed.md for play: ${path.join(campaignPath, SEED_MD)}`,
  );
}

const STOPPED_NOTE = "Stopped. Kept the reply so far — Continue finishes it.";
const HYGIENE_STOPPED = "stopped";
// the transcript cursor stays put, so the next pass covers these Turns too
const HYGIENE_STOPPED_NOTE =
  "Memory hygiene stopped. The next pass will catch up on these Turns.";

export {
  buildContinueInstruction,
  composeContinuedProse,
  CONTINUE_INSTRUCTION_MARK,
} from "./continue_prose.ts";

export async function readSeedOrThrow(campaignPath: string): Promise<string> {
  try {
    return await readFile(path.join(campaignPath, SEED_MD), "utf8");
  } catch {
    throw missingSeedError(campaignPath);
  }
}

export type { TranscriptRow };
