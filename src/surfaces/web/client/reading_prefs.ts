/**
 * How the book's text reads: typeface and size. A per-browser preference,
 * like the local model choices in local_prefs.ts, so it lives in
 * localStorage and never reaches the Campaign or the server.
 */

export type Typeface = "garamond" | "alegreya" | "crimson" | "literata";

export type TypefaceChoice = {
  id: Typeface;
  name: string;
  note: string;
  stack: string;
  /** Google Fonts family spec, loaded only when this face is chosen. */
  google?: string;
};

const FALLBACK = `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`;

export const TYPEFACES: readonly TypefaceChoice[] = [
  {
    id: "garamond",
    name: "EB Garamond",
    note: "The book's own face.",
    stack: `"EB Garamond", ${FALLBACK}`,
  },
  {
    id: "alegreya",
    name: "Alegreya",
    note: "Old-world and calligraphic, with sturdier strokes.",
    stack: `"Alegreya", "EB Garamond", ${FALLBACK}`,
    google: "Alegreya:ital,wght@0,400;0,500;0,600;1,400;1,500",
  },
  {
    id: "crimson",
    name: "Crimson Pro",
    note: "A Garamond cousin that holds up better on screen.",
    stack: `"Crimson Pro", "EB Garamond", ${FALLBACK}`,
    google: "Crimson+Pro:ital,wght@0,400;0,500;0,600;1,400;1,500",
  },
  {
    id: "literata",
    name: "Literata",
    note: "Made for reading on screens. The clearest of these.",
    stack: `"Literata", "EB Garamond", ${FALLBACK}`,
    google: "Literata:ital,wght@0,400;0,500;0,600;1,400;1,500",
  },
];

export const TEXT_SIZES: ReadonlyArray<{ label: string; scale: number }> = [
  { label: "Smaller", scale: 0.92 },
  { label: "Standard", scale: 1 },
  { label: "Larger", scale: 1.1 },
  { label: "Largest", scale: 1.22 },
];

export type ReadingPrefs = { typeface: Typeface; scale: number };

export const DEFAULT_READING: ReadingPrefs = { typeface: "garamond", scale: 1 };

const KEY = "nq.reading";

export function readReadingPrefs(): ReadingPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULT_READING;
    const parsed = JSON.parse(raw) as Partial<ReadingPrefs>;
    const typeface = TYPEFACES.some((t) => t.id === parsed.typeface)
      ? (parsed.typeface as Typeface)
      : DEFAULT_READING.typeface;
    const scale = TEXT_SIZES.some((s) => s.scale === parsed.scale)
      ? (parsed.scale as number)
      : DEFAULT_READING.scale;
    return { typeface, scale };
  } catch {
    return DEFAULT_READING;
  }
}

export function writeReadingPrefs(prefs: ReadingPrefs): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // private windows and blocked storage just forget the choice
  }
}

/** Fetch a face's font files once; the book's own face is always loaded. */
export function loadTypeface(face: TypefaceChoice): void {
  if (!face.google || typeof document === "undefined") return;
  if (document.getElementById(`nq-font-${face.id}`)) return;
  const link = document.createElement("link");
  link.id = `nq-font-${face.id}`;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${face.google}&display=swap`;
  document.head.appendChild(link);
}

/** Point the page's text face and size at `prefs`. */
export function applyReadingPrefs(prefs: ReadingPrefs): void {
  if (typeof document === "undefined") return;
  const face = TYPEFACES.find((t) => t.id === prefs.typeface) ?? TYPEFACES[0]!;
  loadTypeface(face);
  const root = document.documentElement.style;
  root.setProperty("--text", face.stack);
  root.setProperty("--reading-scale", String(prefs.scale));
}
