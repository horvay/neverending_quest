/** Cheap stable estimator for POC ceilings. Safe to import from the book. */
export function estimateTokensDefault(text: string): number {
  return Math.ceil(text.length / 4);
}
