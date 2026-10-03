import { SKELETON_FILES } from "./leaves.ts";

/** The Status leaf's facts: name, Turns, Luck Points, and which leaves exist. */
export function statusColophon(raw: string): {
  name?: string;
  turns?: number;
  luckPoints: number;
  luckArmed: boolean;
  files: string[];
} {
  const name = raw.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const turnsRaw = raw.match(/^success_turn_count:\s*(\d+)/m)?.[1];
  const turns = turnsRaw !== undefined ? Number(turnsRaw) : undefined;
  const luckRaw = raw.match(/^luck_points:\s*(\d+)/m)?.[1];
  const luckPoints = luckRaw === undefined ? 5 : Number(luckRaw);
  const luckArmed = /^luck_armed:\s*yes\b/m.test(raw) && luckPoints > 0;
  const files = SKELETON_FILES.filter((key) =>
    new RegExp(`^\\s*${key}:\\s*yes\\b`, "m").test(raw),
  );
  return { name, turns, luckPoints, luckArmed, files };
}
