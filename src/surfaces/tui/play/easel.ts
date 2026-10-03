import type { PlayEvent } from "../../../play/types.ts";

/** The sittings painted so far for one Illustration (slots 0–3). */
export const SITTINGS = 4;

/** An Illustration on the easel, from the brush to a kept (or dropped) sitting. */
export type Easel = {
  ts?: string;
  prompt?: string;
  /** Slots that have landed on disk. */
  landed: boolean[];
  /** Still rewriting the scene or painting. */
  painting: boolean;
};

/** Fold one PlayEvent into the easel; null when nothing is on it. */
export function easelEvent(easel: Easel | null, ev: PlayEvent): Easel | null {
  switch (ev.type) {
    case "illustrate_started":
      return { ...(easel ?? { landed: [] }), ts: ev.ts, painting: true, landed: [] };
    case "illustrate_prompt":
      return easel ? { ...easel, ts: ev.ts, prompt: ev.prompt } : easel;
    case "illustrate_candidate": {
      if (!easel) return easel;
      const landed = [...easel.landed];
      landed[ev.slot] = true;
      return { ...easel, ts: ev.ts, landed };
    }
    case "illustrate_ended":
      return ev.ok && easel ? { ...easel, painting: false } : null;
    case "illustrate_picked":
    case "illustrate_cancelled":
      return null;
    default:
      return easel;
  }
}

export function landedCount(easel: Easel): number {
  return easel.landed.filter(Boolean).length;
}

/** The easel under the story: the prompt, then each sitting by number. */
export function easelLines(easel: Easel): string[] {
  const out = ["Easel", "─".repeat(32)];
  out.push(easel.prompt ? easel.prompt : "Reading the scene…");
  for (let slot = 0; slot < SITTINGS; slot++) {
    out.push(
      easel.landed[slot]
        ? `  ${slot + 1}  ready · /look ${slot + 1}`
        : `  ${slot + 1}  ${easel.painting ? "painting…" : "—"}`,
    );
  }
  out.push("/keep <n> keeps a sitting · /cancel puts the brush down");
  return out;
}

export function easelStatus(easel: Easel): string {
  const n = landedCount(easel);
  return easel.painting
    ? `Painting… · ${n} of ${SITTINGS} sittings`
    : `Pick a sitting · ${n} of ${SITTINGS} ready · /keep <n>`;
}
