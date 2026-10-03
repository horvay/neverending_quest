/**
 * Tiny TOML subset: top-level keys, [tables], strings, numbers, booleans.
 * Enough for nq config.toml — not a full TOML implementation.
 */
export function parseTomlish(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  const lines = raw.split(/\r?\n/);

  for (const lineRaw of lines) {
    const line = lineRaw.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;

    const table = /^\[([a-zA-Z0-9_.-]+)\]$/.exec(line);
    if (table) {
      const name = table[1]!;
      const parts = name.split(".");
      let node: Record<string, unknown> = root;
      for (const p of parts) {
        const existing = node[p];
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
          node[p] = {};
        }
        node = node[p] as Record<string, unknown>;
      }
      current = node;
      continue;
    }

    const kv = /^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    current[key] = parseValue(kv[2]!.trim());
  }

  return root;
}

function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}
