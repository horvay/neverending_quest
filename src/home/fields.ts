/**
 * Small pieces Home's forms share on both Player Surfaces.
 *
 * Pure: no Node, so the web book bundles it as the terminal Home imports it.
 */

/** Thinking levels a Game Master may be asked for, from none to the most. */
export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
] as const;

/**
 * A number input reports "" while a value is still being typed, notably for a
 * lone "-". Coercing that to 0 rewrites the field under the user and makes
 * negative values such as the -1 "unlimited" budget impossible to enter.
 */
export function partialNumber(raw: string): number | undefined {
  const text = raw.trim();
  if (text === "" || text === "-") return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}
