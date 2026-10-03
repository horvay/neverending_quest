import { parseDossierFrontmatter } from "../../../campaign/frontmatter.ts";
import type { LocalLogChunk } from "@nq/local-inference/logs.ts";
import type { RollLogEntry } from "../../../play/roll_log.ts";
import type { InspectLeaf } from "../../../play/types.ts";
import {
  BLANK_REASON,
  LEAF_TITLE,
  inspectHasInk,
  inspectWritable,
} from "../../shared/leaves.ts";
import { dossierExcerpt, rankDossierHits } from "../../shared/seek.ts";
import { statusColophon } from "../../shared/status.ts";
import { leavesLine } from "../../shared/text.ts";
import { STALE } from "./copy.ts";

/**
 * Read views that take the story's place until Esc: Inspect leaves, the
 * Dossier index, the Roll Log, settings, the AI log and help. Each is plain
 * text; the chrome draws it and says how to leave.
 */

const RULE = "─".repeat(32);

/** An open Inspect leaf, as last read from disk. */
export type LeafView = {
  target: string;
  slug?: string;
  leaf: InspectLeaf;
  /** The last save met newer text on disk; `leaf` now holds that text. */
  stale?: boolean;
  error?: string;
  /** Twists stay veiled until the player chooses to read ahead. */
  veiled?: boolean;
};

export function leafWritable(view: LeafView): boolean {
  return inspectWritable({ target: view.target, slug: view.slug });
}

function heading(kicker: string, title: string): string[] {
  return [`${kicker} · ${title}`, RULE];
}

export function formatLeaf(view: LeafView): string {
  const { target, slug, leaf } = view;
  const titled = LEAF_TITLE[target];
  const archived = target === "dossiers" && "archived" in leaf && leaf.archived;
  const kicker =
    target === "dossiers" && slug
      ? archived
        ? "Dossier · archived"
        : "Dossier"
      : (titled?.kicker ?? target);
  const title =
    target === "dossiers" && slug
      ? parseDossierFrontmatter(leaf.text).name?.trim() || slug
      : (titled?.title ?? target);
  const out = heading(kicker, title);
  if (view.stale) out.push(STALE, "");
  else if (view.error) out.push(view.error, "");
  if (target === "status") {
    out.push(...statusLines(leaf.text));
    return out.join("\n");
  }
  if (target === "twists" && view.veiled && inspectHasInk(leaf.text)) {
    out.push(
      "Turns the book has not taken yet.",
      "The Game Master keeps what it might spring on you here. Reading it is reading ahead.",
      "",
      "/twists again to read ahead anyway.",
    );
    return out.join("\n");
  }
  if (!inspectHasInk(leaf.text)) {
    out.push(
      "This leaf is still clean.",
      BLANK_REASON[target] ?? "Nothing is written on this leaf yet.",
    );
  } else {
    out.push(leaf.text.trimEnd());
  }
  return out.join("\n");
}

function statusLines(raw: string): string[] {
  const { name, turns, luckPoints, luckArmed, files } = statusColophon(raw);
  const out: string[] = [];
  if (name) out.push(name);
  if (turns !== undefined) out.push(`${turns} turn${turns === 1 ? "" : "s"} so far.`);
  if (files.length > 0) out.push(leavesLine(files));
  out.push(
    "",
    `Luck Points: ${luckPoints} left${luckArmed ? " · armed" : ""}`,
    luckPoints > 0
      ? luckArmed
        ? "The next die will land on its highest face. /luck disarms it."
        : "Arm one point to max the next roll: /luck"
      : "No luck remains in this Campaign.",
    "",
    "Reconcile the book: /light catch up · /heavy tidy · /compact · /fresh",
    "Rolls: /rolls · Earlier turns: /history",
  );
  return out;
}

/** What a leaf view says it can do, on the status line. */
export function leafHint(view: LeafView): string {
  if (view.target === "dossiers" && view.slug) {
    const archived = "archived" in view.leaf && view.leaf.archived;
    return `Esc back · /ink to write · ${archived ? "/restore" : "/archive"} · /dossiers`;
  }
  return leafWritable(view) ? "Esc back · /ink to write" : "Esc back";
}

export type DossierIndexView = {
  leaf: InspectLeaf;
  query: string;
  /** The Archives section is open (always, while seeking). */
  archives: boolean;
  error?: string;
};

export function formatDossierIndex(view: DossierIndexView): string {
  const title = LEAF_TITLE.dossiers!;
  const out = heading(title.kicker, title.title);
  const entries = "entries" in view.leaf ? (view.leaf.entries ?? []) : [];
  const query = view.query.trim();
  if (query) out.push(`Seek: ${query}`, "");
  if (view.error) out.push(view.error, "");
  if (entries.length === 0) {
    out.push(
      "No names are entered yet. People will appear here as they are met — or write one now: /new <name>",
    );
    return out.join("\n");
  }
  const hits = rankDossierHits(entries, query);
  if (hits.length === 0) {
    out.push("Nothing on these leaves matches.");
    return out.join("\n");
  }
  const row = (e: (typeof hits)[number]) => {
    const lines = [`  ${e.name ?? e.slug}  (${e.slug})`];
    const excerpt = e.via === "body" ? dossierExcerpt(e, query) : "";
    if (excerpt) lines.push(`      ${excerpt}`);
    return lines;
  };
  const live = hits.filter((e) => !e.archived);
  const filed = hits.filter((e) => e.archived);
  for (const e of live) out.push(...row(e));
  if (filed.length > 0) {
    if (live.length > 0) out.push("");
    if (view.archives || query) {
      out.push("Archives");
      for (const e of filed) out.push(...row(e));
    } else {
      out.push(`Archives (${filed.length}) · /archives to list them`);
    }
  }
  return out.join("\n");
}

export const DOSSIER_INDEX_HINT =
  "Esc back · /dossier <slug> · /new <name> · /archive <slug> · /restore <slug>";

export function formatRollLog(rolls: RollLogEntry[]): string {
  const out = heading("Status", "Rolls");
  if (rolls.length === 0) {
    out.push("No rolls have been made.");
    return out.join("\n");
  }
  for (const roll of rolls) {
    out.push(
      `Turn ${roll.turn} · ${roll.value} / d${roll.n} · ${roll.reason ?? "Purpose not recorded."}`,
    );
  }
  return out.join("\n");
}

/** A roll as it happens: die, result, purpose. */
export function rollNotice(roll: { n: number; value: number; reason?: string }): string {
  return `Rolled d${roll.n} → ${roll.value} · ${roll.reason ?? "Purpose not recorded."}`;
}

/** Mid-Campaign play settings, in the web Settings leaf's order and words. */
export const PLAY_SETTINGS: ReadonlyArray<{
  key: string;
  label: string;
  unit?: string;
  kind: "number" | "text" | "flag";
}> = [
  { key: "gmPersonality", label: "Personality", kind: "text" },
  { key: "turnTimeoutSec", label: "Turn inactivity timeout", unit: "seconds", kind: "number" },
  { key: "maxTokens", label: "Max reply tokens", unit: "tokens", kind: "number" },
  { key: "hygieneN", label: "Light hygiene every", unit: "turns", kind: "number" },
  { key: "compactCeilingTokens", label: "Context ceiling", unit: "tokens", kind: "number" },
  { key: "compactSeedPercent", label: "Rebuild seed ceiling", unit: "% of ceiling", kind: "number" },
  { key: "playTranscriptTailRows", label: "Transcript tail", unit: "rows", kind: "number" },
  { key: "debug", label: "Debug logging", kind: "flag" },
  { key: "logPath", label: "Log file", kind: "text" },
];

export function openPlaySettings(fixed: readonly string[]) {
  return PLAY_SETTINGS.filter((s) => !fixed.includes(s.key));
}

export function formatSettings(
  settings: Record<string, unknown>,
  fixed: readonly string[],
  status?: string,
): string {
  const out = heading("How this book reads and plays", "Settings");
  const shown = openPlaySettings(fixed);
  const width = Math.max(...shown.map((s) => s.key.length));
  for (const s of shown) {
    const raw = settings[s.key];
    const value =
      s.kind === "flag"
        ? raw
          ? "on"
          : "off"
        : s.kind === "text"
          ? String(raw ?? "").trim() || "(none)"
          : `${String(raw)}${s.unit ? ` ${s.unit}` : ""}`;
    out.push(`${s.key.padEnd(width)}  ${value}   ${s.label}`);
  }
  out.push(
    "",
    "Saved to your settings and used by this adventure from the next Turn.",
    "The model, provider, and local engine are chosen on Home: changing them needs a fresh start.",
  );
  if (status) out.push("", status);
  return out.join("\n");
}

export const SETTINGS_HINT = "Esc back · /set <key> <value>";

export function formatLocalLog(chunk: LocalLogChunk | { error: string }): string {
  if ("error" in chunk) return [...heading("Local AI log", "Raw inference diagnostics"), chunk.error].join("\n");
  const out = heading("Local AI log", chunk.file ? `Raw inference diagnostics · ${chunk.file}` : "Raw inference diagnostics");
  if (!chunk.available) {
    out.push(
      chunk.source === "engine"
        ? "No AI engine log yet. It appears when a local model starts."
        : "No inference host log yet. It appears when the local host starts.",
    );
  } else {
    out.push(chunk.text.trimEnd() || "Waiting for log output…");
  }
  return out.join("\n");
}

export function formatHelp(lines: string[]): string {
  return [...heading("Neverending Quest", "Commands"), ...lines, "", "Type anything else to play it. Esc closes a view; PgUp/PgDn scroll."].join(
    "\n",
  );
}

/** What takes the story's place until Esc. */
export type ReadView =
  | { kind: "leaf"; leaf: LeafView }
  | { kind: "dossiers"; index: DossierIndexView }
  | { kind: "text"; name: "rolls" | "settings" | "log" | "help"; text: string; hint: string };

export function formatView(view: ReadView): string {
  if (view.kind === "leaf") return formatLeaf(view.leaf);
  if (view.kind === "dossiers") return formatDossierIndex(view.index);
  return view.text;
}

export function viewHint(view: ReadView): string {
  if (view.kind === "leaf") return leafHint(view.leaf);
  if (view.kind === "dossiers") return DOSSIER_INDEX_HINT;
  return view.hint;
}
