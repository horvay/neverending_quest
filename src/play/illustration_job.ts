import { CampaignError } from "../campaign/errors.ts";
import { commitCampaign } from "../campaign/history.ts";
import { readTranscript } from "../campaign/transcript.ts";
import type { TranscriptRow } from "../campaign/types.ts";
import {
  assertIllustrationSlot,
  buildIllustrationBtwPrompt,
  chooseIllustrationPng,
  illustrationCandidateAbs,
  illustrationVariantSeeds,
  ILLUSTRATION_VARIANT_COUNT,
  parseIllustrationPrompt,
  removeIllustrationCandidates,
  stampIllustration,
} from "./illustration.ts";
import type { ScratchRecorder } from "./scratch_recorder.ts";
import type { AgentSession, Illustrator, PlayEvent } from "./types.ts";

/** What an Illustration needs from the Play Loop that runs it. */
export type IllustrationHost = {
  emit(event: PlayEvent): void;
  /** The open Campaign folder; unset before the loop opens. */
  campaignPath(): string | undefined;
  /** The play session, whose lookup turn rewrites the scene into a prompt. */
  session(): AgentSession | null;
  scratch: ScratchRecorder;
  closed(): boolean;
  /** Assert Idle and take the authoring lock; throws CampaignError otherwise. */
  claim(action: string): void;
  /** Drop the authoring lock if it is still held. */
  release(): void;
  emitStoryReplaced(): Promise<void>;
};

type PendingIllustration = {
  ts: string;
  prompt: string;
  slots: Array<string | undefined>;
  abort: AbortController;
  finished: PromiseWithResolvers<void>;
  chosen?: number;
  cancelled?: boolean;
};

/**
 * One Illustration at a time: rewrite the latest GM row into an image prompt,
 * paint the variants, then wait (still authoring) for the player to pick one
 * or cancel. Stamp and commit happen on pick. A pick or cancel that lands
 * while painting is still running is settled by the painting run itself.
 */
export class IllustrationJob {
  private pending: PendingIllustration | null = null;
  private running = false;
  private cancelRequested = false;

  constructor(
    private readonly host: IllustrationHost,
    private readonly illustrator?: Illustrator,
  ) {}

  async status(): Promise<{ ready: boolean; reason?: string }> {
    const illustrator = this.illustrator;
    if (!illustrator || !(illustrator.paintBatch || illustrator.paintOne)) {
      return { ready: false, reason: "No painter is set up on this machine." };
    }
    return (await illustrator.status?.()) ?? { ready: true };
  }

  /** Close: stop painting without waiting for it or cleaning up. */
  abandon(): void {
    this.cancelRequested = true;
    this.pending?.abort.abort();
  }

  async run(
    opts?: { prompt?: string },
  ): Promise<{ ts: string; prompt: string }> {
    this.host.claim("illustrate");
    this.cancelRequested = false;
    this.running = true;
    let ts: string | undefined;
    let ok = false;
    let waiting = false;
    try {
      const status = await this.status();
      if (!status.ready) {
        throw new CampaignError(
          "unavailable",
          status.reason ?? "Illustration runner is not installed",
        );
      }
      const root = this.host.campaignPath()!;
      const rows = await readTranscript(root);
      let latest: TranscriptRow | undefined;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]!.role === "gm") {
          latest = rows[i];
          break;
        }
      }
      if (!latest) {
        throw new CampaignError("not_found", "No Game Master row to illustrate");
      }
      ts = latest.ts;
      const pending: PendingIllustration = {
        ts,
        prompt: "",
        slots: [],
        abort: new AbortController(),
        finished: Promise.withResolvers<void>(),
      };
      this.pending = pending;
      if (this.cancelRequested) {
        throw new CampaignError("busy", "Illustration was interrupted");
      }
      this.host.emit({ type: "illustrate_started", ts });
      this.host.scratch.reset();
      this.host.scratch.emitLive();
      let prompt: string;
      const given = opts?.prompt?.trim();
      if (given) {
        const parsed = parseIllustrationPrompt(given);
        if (!parsed) {
          throw new CampaignError(
            "bad_prompt",
            "Could not make an image prompt from this scene",
          );
        }
        prompt = parsed;
      } else {
        let raw: { prose: string; aborted?: boolean; error?: string };
        const session = this.host.session();
        if (session?.runLookupTurn) {
          raw = await session.runLookupTurn({
            promptText: buildIllustrationBtwPrompt(latest.text),
            signal: pending.abort.signal,
            onEvent: (ev) => this.host.scratch.ingest(ev),
          });
        } else if (session?.runEphemeralTurn) {
          raw = await session.runEphemeralTurn({
            promptText: buildIllustrationBtwPrompt(latest.text),
            signal: pending.abort.signal,
          });
        } else {
          throw new CampaignError(
            "unavailable",
            "Play session cannot rewrite an image prompt",
          );
        }
        if (pending.cancelled || this.cancelRequested || raw.aborted) {
          this.host.emit({ type: "illustrate_cancelled", ts });
          return { ts, prompt: "" };
        }
        if (raw.error) {
          throw new CampaignError("generate_failed", raw.error);
        }
        const parsed = parseIllustrationPrompt(raw.prose);
        if (!parsed) {
          throw new CampaignError(
            "bad_prompt",
            "Could not make an image prompt from this scene",
          );
        }
        prompt = parsed;
      }
      pending.prompt = prompt;
      this.host.emit({ type: "illustrate_prompt", ts, prompt });
      await this.paint(root, pending, prompt);
      if (pending.cancelled || this.cancelRequested) {
        this.host.emit({ type: "illustrate_cancelled", ts });
        return { ts, prompt };
      }
      if (pending.chosen !== undefined) {
        await this.finalizePick();
        ok = true;
        return { ts, prompt };
      }
      if (!pending.slots.some(Boolean)) {
        throw new CampaignError("generate_failed", "No sittings were painted");
      }
      ok = true;
      waiting = true;
      return { ts, prompt };
    } finally {
      this.running = false;
      this.pending?.finished.resolve();
      const pending = this.pending;
      const cancelled = Boolean(pending?.cancelled || this.cancelRequested);
      const root = this.host.campaignPath();
      if (waiting) {
        this.host.emit({ type: "illustrate_ended", ok: true, ...(ts ? { ts } : {}) });
      } else if (cancelled) {
        if (ts && root) {
          await removeIllustrationCandidates(root, ts).catch(() => {});
        }
        this.pending = null;
        this.host.release();
      } else if (!ok) {
        if (ts && root) {
          await removeIllustrationCandidates(root, ts).catch(() => {});
        }
        this.pending = null;
        this.host.emit({ type: "illustrate_ended", ok: false, ...(ts ? { ts } : {}) });
        this.host.release();
      }
    }
  }

  /** Paint every variant, stopping early once the player picks or cancels. */
  private async paint(
    root: string,
    pending: PendingIllustration,
    prompt: string,
  ): Promise<void> {
    const { ts } = pending;
    const seeds = illustrationVariantSeeds();
    const paintBatch = this.illustrator?.paintBatch?.bind(this.illustrator);
    if (paintBatch) {
      try {
        await paintBatch({
          prompt,
          seeds,
          outPaths: seeds.map((_, slot) =>
            illustrationCandidateAbs(root, ts, slot),
          ),
          signal: pending.abort.signal,
          onCandidate: (candidate) => {
            const slot = assertIllustrationSlot(candidate.slot);
            pending.slots[slot] = candidate.path;
            this.host.emit({ type: "illustrate_candidate", ts: pending.ts, slot });
          },
        });
      } catch (err) {
        if (
          !pending.cancelled &&
          pending.chosen === undefined &&
          !pending.abort.signal.aborted
        ) {
          if (err instanceof CampaignError) throw err;
          throw new CampaignError(
            "generate_failed",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      return;
    }
    for (let slot = 0; slot < ILLUSTRATION_VARIANT_COUNT; slot++) {
      if (
        pending.cancelled ||
        pending.chosen !== undefined ||
        pending.abort.signal.aborted
      ) {
        break;
      }
      const outPath = illustrationCandidateAbs(root, ts, slot);
      const seed = seeds[slot]!;
      try {
        await this.illustrator!.paintOne!({
          prompt,
          outPath,
          seed,
          slot,
          signal: pending.abort.signal,
        });
      } catch (err) {
        if (
          pending.cancelled ||
          pending.chosen !== undefined ||
          pending.abort.signal.aborted
        ) {
          break;
        }
        if (err instanceof CampaignError) throw err;
        throw new CampaignError(
          "generate_failed",
          err instanceof Error ? err.message : String(err),
        );
      }
      pending.slots[slot] = outPath;
      this.host.emit({ type: "illustrate_candidate", ts, slot });
    }
  }

  async pick(slot: number): Promise<{ ts: string; prompt: string }> {
    const pending = this.pending;
    if (!pending || this.host.closed() || !this.host.campaignPath()) {
      throw new CampaignError("not_found", "No sitting to choose");
    }
    if (!pending.slots[slot]) {
      throw new CampaignError("not_found", "That sitting is not ready");
    }
    pending.chosen = slot;
    pending.abort.abort();
    if (this.running) {
      await pending.finished.promise;
      if (!this.host.campaignPath()) {
        throw new CampaignError("busy", "PlayLoop not open");
      }
      return { ts: pending.ts, prompt: pending.prompt };
    }
    await this.finalizePick();
    return { ts: pending.ts, prompt: pending.prompt };
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    const pending = this.pending;
    if (pending) pending.cancelled = true;
    pending?.abort.abort();
    if (this.running) {
      if (pending) await pending.finished.promise;
      return;
    }
    const root = this.host.campaignPath();
    if (!pending || !root) {
      this.host.release();
      return;
    }
    const ts = pending.ts;
    this.pending = null;
    await removeIllustrationCandidates(root, ts).catch(() => {});
    this.host.emit({ type: "illustrate_cancelled", ts });
    this.host.release();
  }

  private async finalizePick(): Promise<void> {
    const pending = this.pending;
    const root = this.host.campaignPath();
    if (!pending || pending.chosen === undefined || !root) {
      throw new CampaignError("not_found", "No sitting to choose");
    }
    const { ts, prompt, chosen } = pending;
    await chooseIllustrationPng(root, ts, chosen);
    await stampIllustration(root, ts, prompt);
    await commitCampaign(root, "illustrate");
    await removeIllustrationCandidates(root, ts).catch(() => {});
    this.pending = null;
    this.host.emit({ type: "illustrate_picked", ts, slot: chosen });
    await this.host.emitStoryReplaced();
    this.host.release();
  }
}
