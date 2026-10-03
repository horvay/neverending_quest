import { LEAF_NAME, SKELETON_FILES } from "./leaves.ts";

export function romanTurn(n: number): string {
  if (n <= 0) return "Opening";
  const map: Array<[number, string]> = [
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let rest = n;
  let out = "";
  for (const [value, glyph] of map) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

export function clipProse(s: string, max = 90): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  const kept = (sp > 40 ? cut.slice(0, sp) : cut).replace(/[.,;:]+$/, "");
  return `${kept}.`;
}

export function leavesLine(files: string[]): string {
  const named = files.map(
    (key) => LEAF_NAME[key as (typeof SKELETON_FILES)[number]] ?? key,
  );
  if (named.length === 0) return "";
  if (named.length === 1) return `Leaves in this book: ${named[0]}.`;
  const last = named[named.length - 1];
  return `Leaves in this book: ${named.slice(0, -1).join(", ")}, ${last}.`;
}

export function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
