export const CONTINUE_INSTRUCTION_MARK =
  "[Continue — same Game Master line]";

/** Hidden (no player row) instruction: finish the last GM line, suffix only. */
export function buildContinueInstruction(stub: string): string {
  const tail = continueTail(stub);
  const lines = [
    CONTINUE_INSTRUCTION_MARK,
    "The last Game Master prose is unfinished. It is already the previous assistant message.",
  ];
  if (tail) {
    lines.push(`It ends with: «${tail}»`);
  }
  lines.push(
    "Reply with only the continuation — the next words after that ending.",
    "Start after the prefix. Stay in the same scene and the same Game Master turn.",
  );
  return lines.join("\n");
}

/**
 * Keep the stub prefix. Prefer a true suffix or an overlapped join.
 * Drop a recognized restatement, but keep any other nonempty output as a new
 * paragraph rather than guessing that it rewrites the stub.
 */
export function composeContinuedProse(stub: string, modelOut: string): string {
  if (stub.length === 0) return modelOut;
  if (!modelOut.trim()) return stub;
  if (modelOut.startsWith(stub)) return modelOut;

  const trimmed = modelOut.trimStart();
  if (trimmed.startsWith(stub)) {
    return stub + trimmed.slice(stub.length);
  }
  if (stub.startsWith(trimmed) && trimmed.length < stub.length) {
    return stub;
  }

  const overlap = longestOverlap(stub, modelOut);
  if (overlap >= MIN_OVERLAP) {
    return stub + modelOut.slice(overlap);
  }
  const trimmedOverlap = longestOverlap(stub, trimmed);
  if (trimmedOverlap >= MIN_OVERLAP) {
    return stub + trimmed.slice(trimmedOverlap);
  }

  const wordJoin = mergeAtWordOverlap(stub, trimmed);
  if (wordJoin) return wordJoin;

  if (looksLikeSuffix(trimmed)) {
    return glueContinued(stub, trimmed);
  }

  const after = continuationAfterRestatement(stub, trimmed);
  if (after !== null) {
    return after.length === 0 ? stub : glueContinued(stub, after);
  }

  if (trimmed.includes(stub)) return trimmed;
  return `${stub}\n\n${modelOut}`;
}

const MIN_OVERLAP = 3;
const TAIL_CHARS = 80;

function continueTail(stub: string): string {
  const collapsed = stub.replace(/\s+/gu, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= TAIL_CHARS) return collapsed;
  return collapsed.slice(-TAIL_CHARS).trimStart();
}

function glueContinued(stub: string, next: string): string {
  if (
    /\s$/u.test(stub) ||
    /^\s/u.test(next) ||
    /^[.,!?;:…—*–]/u.test(next)
  ) {
    return `${stub}${next}`;
  }
  return `${stub} ${next}`;
}

function looksLikeSuffix(text: string): boolean {
  if (!text) return false;
  if (/^[.,!?;:…—*–"'”)\]]/u.test(text)) return true;
  const first = text[0]!;
  return first === first.toLowerCase() && first !== first.toUpperCase();
}

function longestOverlap(stub: string, out: string): number {
  const max = Math.min(stub.length, out.length);
  for (let n = max; n >= MIN_OVERLAP; n--) {
    if (stub.endsWith(out.slice(0, n))) return n;
  }
  return 0;
}

function mergeAtWordOverlap(stub: string, out: string): string | undefined {
  const stubWords = tokenizeWords(stub);
  const outWords = tokenizeWords(out);
  const max = Math.min(stubWords.length, outWords.length);
  for (let n = max; n >= 2; n--) {
    const suffix = stubWords.slice(-n);
    if (suffix.every((w, i) => w === outWords[i])) {
      const rest = outWords.slice(n).join(" ");
      return rest ? glueContinued(stub, rest) : stub;
    }
  }
  return undefined;
}

function tokenizeWords(text: string): string[] {
  return text
    .replace(/[*_]/gu, "")
    .split(/\s+/u)
    .map((w) => w.trim())
    .filter(Boolean);
}

function lastSentence(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/u);
  return parts.at(-1) ?? text;
}

function firstWords(text: string, n: number): string[] {
  return tokenizeWords(text).slice(0, n);
}

function sharesOpening(stub: string, out: string): boolean {
  const a = firstWords(lastSentence(stub), 2);
  const b = firstWords(out, 2);
  return (
    a.length >= 2 &&
    b.length >= 2 &&
    a[0]!.toLowerCase() === b[0]!.toLowerCase() &&
    a[1]!.toLowerCase() === b[1]!.toLowerCase()
  );
}

function firstSentenceEnd(text: string): number {
  const re = /[.!?](?:["”']|\*)*(?:\s+|$)/u;
  const m = re.exec(text);
  if (!m) return -1;
  return m.index + m[0].length;
}

/** Drop a restated first sentence that restarts the stub's last line. */
function continuationAfterRestatement(
  stub: string,
  out: string,
): string | null {
  if (!sharesOpening(stub, out)) return null;
  const end = firstSentenceEnd(out);
  if (end < 0) return null;
  return out.slice(end).trimStart();
}
