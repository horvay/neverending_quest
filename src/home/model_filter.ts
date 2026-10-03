/** Show every model only when the catalog is small enough to scan. */
export const HOME_MODEL_LIST_LIMIT = 24;

export type HomeChoice = {
  name: string;
  selector?: string;
};

export function filterHomeChoices<T extends HomeChoice>(
  items: readonly T[],
  query: string,
): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...items];
  return items.filter((item) => {
    const hay = `${item.name} ${item.selector ?? ""}`.toLowerCase();
    return tokens.every((token) => hay.includes(token));
  });
}

export function visibleHomeChoices<T extends HomeChoice>(
  items: readonly T[],
  query: string,
): { shown: T[]; total: number; needQuery: boolean } {
  const filtered = filterHomeChoices(items, query);
  if (query.trim().length > 0 || items.length <= HOME_MODEL_LIST_LIMIT) {
    return { shown: filtered, total: items.length, needQuery: false };
  }
  return { shown: [], total: items.length, needQuery: true };
}
