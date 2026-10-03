/**
 * Detects a Game Master reply collapsing into a repetition loop.
 *
 * A local model that loses coherence emits the same short phrase over and over
 * ("We need we. We need we."). The prose of a Campaign is itself repetitive by
 * design, so the test has to separate a deliberate refrain from a stuck decoder:
 * only an *immediately consecutive* phrase, or a window whose vocabulary has
 * nearly collapsed, counts.
 */

// Thresholds are set from real transcripts of this project: across degenerate
// replies the longest back-to-back phrase ran 3-4 times and distinct words fell
// to 0.28, while healthy replies never repeated a phrase more than twice and
// stayed above 0.45 distinct - even in a Campaign whose prose leans on refrains
// such as "we do not", which recurs nine times in a single good reply.

/** Phrase repeated back to back at least this many times is a loop. */
const MIN_CONSECUTIVE_REPEATS = 3;
/** Longest phrase, in words, worth testing for repetition. */
const MAX_PHRASE_WORDS = 8;
/** Only judge once there is enough text for the ratio to mean anything. */
const MIN_WORDS_FOR_RATIO = 60;
/** Below this share of distinct words the text has stopped saying anything new. */
const MIN_DISTINCT_RATIO = 0.3;
/** Judge recent output, so a long healthy reply is not excused by its good start. */
const WINDOW_WORDS = 120;

export type RepetitionVerdict = {
  repetitive: boolean;
  /** Human-readable cause, for logs and for telling the player what happened. */
  reason?: string;
};

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** A phrase repeated back to back, e.g. "we need we we need we we need we we need we". */
function consecutivePhrase(tail: string[]): string | undefined {
  for (let size = 1; size <= MAX_PHRASE_WORDS; size++) {
    for (let start = 0; start + size * MIN_CONSECUTIVE_REPEATS <= tail.length; start++) {
      const phrase = tail.slice(start, start + size);
      let repeats = 1;
      let at = start + size;
      while (at + size <= tail.length) {
        let same = true;
        for (let i = 0; i < size; i++) {
          if (tail[at + i] !== phrase[i]) {
            same = false;
            break;
          }
        }
        if (!same) break;
        repeats++;
        at += size;
      }
      if (repeats >= MIN_CONSECUTIVE_REPEATS) return phrase.join(" ");
    }
  }
  return undefined;
}

export function detectRepetition(text: string): RepetitionVerdict {
  const all = words(text);
  const tail = all.slice(-WINDOW_WORDS);

  const phrase = consecutivePhrase(tail);
  if (phrase) {
    return { repetitive: true, reason: `repeated "${phrase}"` };
  }

  if (tail.length >= MIN_WORDS_FOR_RATIO) {
    const distinct = new Set(tail).size / tail.length;
    if (distinct < MIN_DISTINCT_RATIO) {
      return {
        repetitive: true,
        reason: `vocabulary collapsed to ${Math.round(distinct * 100)}% distinct words`,
      };
    }
  }

  return { repetitive: false };
}

/**
 * Streaming wrapper: feed reasoning deltas as they arrive and stop the turn the
 * first time it reports a loop. Re-checking only every few hundred characters
 * keeps the scan off the hot path of every token.
 */
export function createRepetitionWatcher(opts: { checkEveryChars?: number } = {}) {
  const checkEvery = opts.checkEveryChars ?? 200;
  let seen = "";
  let checkedAt = 0;
  let verdict: RepetitionVerdict = { repetitive: false };
  return {
    /** Returns the verdict once, the first time the text looks stuck. */
    push(text: string): RepetitionVerdict {
      if (verdict.repetitive) return { repetitive: false };
      seen = text;
      if (seen.length - checkedAt < checkEvery) return { repetitive: false };
      checkedAt = seen.length;
      verdict = detectRepetition(seen);
      return verdict;
    },
    reset(): void {
      seen = "";
      checkedAt = 0;
      verdict = { repetitive: false };
    },
  };
}
