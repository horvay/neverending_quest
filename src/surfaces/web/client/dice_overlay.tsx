import { useEffect, useRef, useState } from "preact/hooks";
import { dieTypeForN, displayRollReason } from "../../../play/dice.ts";
import { castDie, castPercentile } from "./cast_die.ts";

/** How long a settled cast stays up, and its fade. Tests shorten these. */
export const castTiming = {
  holdMs: 1600,
  reducedHoldMs: 900,
  fadeMs: 320,
};

export type DiceCast = {
  n: number;
  value: number;
  key: number;
  reason?: string;
};

export function DiceOverlay(props: {
  cast: DiceCast | null;
  onDone: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [fading, setFading] = useState(false);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const cast = props.cast;
    if (!cast) {
      setFading(false);
      setSettled(false);
      return;
    }
    const type = dieTypeForN(cast.n);
    const stage = stageRef.current;
    if (!type || !stage) {
      props.onDone();
      return;
    }
    const ac = new AbortController();
    setFading(false);
    setSettled(false);
    void (async () => {
      const dispose =
        type === "d100"
          ? await castPercentile(stage, cast.value, ac.signal)
          : await castDie(stage, type, cast.value, ac.signal);
      if (ac.signal.aborted) {
        dispose();
        return;
      }
      setSettled(true);
      const reduced =
        typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;
      await wait(
        reduced ? castTiming.reducedHoldMs : castTiming.holdMs,
        ac.signal,
      );
      if (ac.signal.aborted) {
        dispose();
        return;
      }
      setFading(true);
      await wait(castTiming.fadeMs, ac.signal);
      dispose();
      if (!ac.signal.aborted) props.onDone();
    })();
    return () => ac.abort();
  }, [props.cast?.key]);

  if (!props.cast) return null;
  const type = dieTypeForN(props.cast.n);
  const heading = props.cast.reason
    ? displayRollReason(props.cast.reason)
    : (type ?? `d${props.cast.n}`);
  const live = `${heading}. ${props.cast.value} on a d${props.cast.n}.`;
  return (
    <div
      class={`dice-cast${fading ? "" : " is-on"}${settled ? " is-settled" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={live}
    >
      <div class="dice-cast-stack">
        <div class="dice-cast-banner">
          <p class="dice-cast-reason">{heading}</p>
        </div>
        <div class="dice-cast-well">
          <div class="dice-cast-glow" aria-hidden="true" />
          <div class="dice-cast-ring" aria-hidden="true" />
          <div
            class={`dice-cast-stage${type === "d100" ? " is-percentile" : ""}`}
            data-percentile={type === "d100" ? "true" : undefined}
            ref={stageRef}
          />
        </div>
        <p class="dice-cast-result" aria-hidden="true">
          {props.cast.value}
        </p>
      </div>
    </div>
  );
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
