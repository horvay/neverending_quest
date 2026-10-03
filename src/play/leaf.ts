export type ContextUsage = {
  used: number;
  /** NQ `[compact] ceiling` (rebuild-compact). Not the model/OMP window. */
  ceiling: number;
};

export function leafSpentRatio(used: number, ceiling: number): number {
  if (ceiling <= 0) return 0;
  return Math.min(1, Math.max(0, used / ceiling));
}

const STEPS: Array<{ at: number; spent: string; remain: string }> = [
  { at: 0, spent: "nothing", remain: "the well is full" },
  { at: 0.12, spent: "a sliver", remain: "almost all the ink" },
  { at: 0.25, spent: "a quarter", remain: "three quarters of the ink" },
  { at: 0.34, spent: "a third", remain: "two thirds of the ink" },
  { at: 0.5, spent: "half", remain: "half the ink" },
  { at: 0.67, spent: "two thirds", remain: "a third of the ink" },
  { at: 0.75, spent: "three quarters", remain: "a quarter of the ink" },
  { at: 0.88, spent: "most", remain: "a sliver of ink" },
  { at: 1, spent: "almost all", remain: "almost no ink" },
];

function nearestStep(ratio: number): (typeof STEPS)[number] {
  let best = STEPS[0]!;
  let dist = Math.abs(ratio - best.at);
  for (const step of STEPS) {
    const d = Math.abs(ratio - step.at);
    if (d < dist) {
      best = step;
      dist = d;
    }
  }
  return best;
}

/** Quiet verso copy: used vs remaining, no token jargon. */
export function leafMarginPhrase(used: number, ceiling: number): {
  ratio: number;
  phrase: string;
  line: string;
} {
  const ratio = leafSpentRatio(used, ceiling);
  if (ratio <= 0.04) {
    return {
      ratio,
      phrase: "the well is full",
      line: "The well is full. Plenty of ink remains.",
    };
  }
  if (ratio >= 0.97) {
    return {
      ratio,
      phrase: "the well is dry",
      line: "The well is dry. Almost no ink remains.",
    };
  }
  const step = nearestStep(ratio);
  return {
    ratio,
    phrase: step.remain,
    line: `The well is ${step.spent} spent; ${step.remain} remains.`,
  };
}
