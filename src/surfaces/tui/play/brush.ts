import type { KernelState } from "../../../play/kernel.ts";
import type { PlayEvent } from "../../../play/types.ts";
import { BUSY, refusal } from "./copy.ts";
import { easelEvent, easelLines, easelStatus, type Easel } from "./easel.ts";
import type { TuiChromeHandlers } from "./handlers.ts";

/** What the brush needs from the chrome around it. */
export type BrushHost = {
  handlers: TuiChromeHandlers;
  state(): KernelState;
  busy(): boolean;
  /** Hold the chrome's write lock while `work` runs. */
  locked(work: () => Promise<void>): Promise<void>;
  /** Back to the story, where the easel is drawn. */
  toStory(): void;
  say(notice?: string): void;
  repaint(): void;
};

/**
 * Illustrations in the terminal: the easel under the story while four
 * sittings paint, `/keep` to stamp one on the latest Game Master row, and
 * `/look` to see a sitting or a kept picture in the player's image viewer.
 */
export function createBrush(host: BrushHost) {
  const { handlers } = host;
  let easel: Easel | null = null;
  let ready = false;

  async function checkReady(): Promise<{ ready: boolean; reason?: string }> {
    const status = (await handlers.illustrationStatus?.().catch(() => undefined)) ?? {
      ready: false,
    };
    ready = status.ready === true;
    return status;
  }

  async function illustrate(prompt?: string): Promise<void> {
    const status = await checkReady();
    if (!status.ready) {
      host.say(status.reason ?? "Illustration runner is not installed.");
      return;
    }
    if (host.busy()) {
      host.say(BUSY);
      return;
    }
    host.toStory();
    easel = { painting: true, landed: [], ...(prompt ? { prompt } : {}) };
    host.repaint();
    // the brush holds the lock until every sitting is painted (or it fails)
    await host.locked(async () => {
      try {
        await handlers.illustrate?.(prompt);
      } catch (err) {
        if (easel?.painting) easel = null;
        host.say(refusal("illustrate", err));
      }
    });
  }

  async function keep(slot: number): Promise<void> {
    if (!easel) {
      host.say("Nothing is on the easel. /illustrate paints the latest line.");
      return;
    }
    if (!easel.landed[slot - 1]) {
      host.say(`Sitting ${slot} is not painted yet.`);
      return;
    }
    try {
      await handlers.pickIllustration?.(slot - 1);
      easel = null;
      host.say(`Kept sitting ${slot}.`);
    } catch (err) {
      host.say(refusal("keep", err));
    }
  }

  async function look(slot?: number): Promise<void> {
    try {
      let file: string | undefined;
      if (slot !== undefined) {
        if (!easel?.ts || !easel.landed[slot - 1]) {
          host.say(easel ? `Sitting ${slot} is not painted yet.` : "Nothing is on the easel.");
          return;
        }
        file = await handlers.illustrationFile?.(easel.ts, slot - 1);
      } else {
        const latest = [...host.state().story].reverse().find((b) => b.role === "gm");
        if (!latest?.illustration) {
          host.say("The latest Game Master line has no picture yet.");
          return;
        }
        file = await handlers.illustrationFile?.(latest.illustration);
      }
      if (file) await handlers.openImage?.(file);
    } catch {
      host.say("Could not open that picture.");
    }
  }

  async function cancel(): Promise<void> {
    if (!easel) {
      host.say("Nothing is on the easel.");
      return;
    }
    easel = null;
    host.repaint();
    await handlers.cancelIllustration?.().catch(() => {});
  }

  return {
    illustrate,
    keep,
    look,
    cancel,
    checkReady,
    get ready() {
      return ready;
    },
    event(ev: PlayEvent) {
      easel = easelEvent(easel, ev);
    },
    /** Lines under the story while something is on the easel. */
    lines: () => (easel ? easelLines(easel) : undefined),
    status: () => (easel ? easelStatus(easel) : undefined),
  };
}
