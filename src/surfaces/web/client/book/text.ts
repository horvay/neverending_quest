export function titleCase(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

export function rowKey(ts: string | undefined, index: number): string {
  return ts ?? `i:${index}`;
}

