export type CssDieType = "d4" | "d6" | "d8" | "d10" | "d12" | "d20";
export type VisualDieType = CssDieType | "d100";

/** Rolls the web overlay can represent; d100 uses two labeled d10s. */
const VISUAL_DIE: Partial<Record<number, VisualDieType>> = {
  4: "d4",
  6: "d6",
  8: "d8",
  10: "d10",
  12: "d12",
  20: "d20",
  100: "d100",
};

export function dieTypeForN(n: number): VisualDieType | undefined {
  return VISUAL_DIE[n];
}

export function rollNFromArgs(args: unknown): number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const n = (args as { n?: unknown }).n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return undefined;
  return n;
}

/** OMP intent (`i`) or an explicit reason/intent field. */
export function rollReasonFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const rec = args as Record<string, unknown>;
  for (const key of ["i", "reason", "intent"] as const) {
    const value = rec[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Player-facing stake. Drops a GM resolution table after a colon. */
export function displayRollReason(raw: string): string {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  const cut = trimmed.indexOf(":");
  if (cut > 0) {
    const tail = trimmed.slice(cut + 1);
    if (/\b(low|mid|high)\b/i.test(tail)) {
      const head = trimmed.slice(0, cut).trim();
      if (head) return head;
    }
  }
  return trimmed;
}

/** Pull the integer the sandbox returned from whatever the agent wrapped it in. */
export function parseRollValue(result: unknown): number | undefined {
  if (typeof result === "number" && Number.isInteger(result)) return result;
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    return undefined;
  }
  if (!result || typeof result !== "object") return undefined;
  const rec = result as Record<string, unknown>;
  if (typeof rec.text === "string") return parseRollValue(rec.text);
  if (Array.isArray(rec.content)) {
    for (const part of rec.content) {
      const value = parseRollValue(part);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

export function visibleRoll(
  n: number | undefined,
  value: number | undefined,
): { n: number; value: number } | undefined {
  if (n === undefined || value === undefined) return undefined;
  if (!dieTypeForN(n)) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > n) return undefined;
  return { n, value };
}
