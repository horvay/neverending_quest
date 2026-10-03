import type { ManualHygieneMode } from "../../../play/types.ts";

/** The Inspect leaves a single command opens. */
export type LeafTarget =
  | "sheet"
  | "world"
  | "beats"
  | "quests"
  | "twists"
  | "seed"
  | "status";

export type SlashCommand =
  | { kind: "edit"; turn?: number }
  | { kind: "delete" }
  | { kind: "continue"; turn?: number }
  | { kind: "scratch"; turn?: number }
  | { kind: "history" }
  | { kind: "hygiene"; mode: ManualHygieneMode }
  | { kind: "retry"; scratch: boolean }
  | { kind: "answer" }
  | { kind: "stop" }
  | { kind: "luck" }
  | { kind: "rolls" }
  | { kind: "leaf"; target: LeafTarget }
  | { kind: "dossiers"; query: string; archives: boolean }
  | { kind: "dossier"; slug: string }
  | { kind: "ink" }
  | { kind: "new"; name: string }
  | { kind: "archive"; slug?: string; archive: boolean }
  | { kind: "illustrate"; prompt?: string }
  | { kind: "keep"; slot: number }
  | { kind: "look"; slot?: number }
  | { kind: "cancel" }
  | { kind: "settings" }
  | { kind: "set"; key: string; value: string }
  | { kind: "log"; source: "engine" | "host" }
  | { kind: "help" }
  | { kind: "quit" }
  /** A known command given arguments it does not take. */
  | { kind: "usage"; usage: string }
  | { kind: "unknown" };

type Spec = {
  names: readonly string[];
  usage: string;
  help: string;
  /** Shown in /help only when the surface can do it right now. */
  when?: "answer" | "scratch" | "illustrate" | "diagnostics";
  /** The command for `rest` (the text after the name), or null if malformed. */
  parse: (rest: string) => SlashCommand | null;
};

const none =
  (cmd: SlashCommand) =>
  (rest: string): SlashCommand | null =>
    rest ? null : cmd;

const optionalTurn =
  (kind: "edit" | "continue" | "scratch") =>
  (rest: string): SlashCommand | null => {
    if (!rest) return { kind };
    return /^\d+$/u.test(rest) ? { kind, turn: Number(rest) } : null;
  };

const oneWord =
  (build: (word: string) => SlashCommand) =>
  (rest: string): SlashCommand | null =>
    rest && !/\s/u.test(rest) ? build(rest) : null;

const slot1to4 = (rest: string): number | null =>
  /^[1-4]$/u.test(rest) ? Number(rest) : null;

const LEAVES: ReadonlyArray<[LeafTarget, string]> = [
  ["sheet", "Show the Player Sheet"],
  ["world", "Show World-Building"],
  ["seed", "Show the Seed"],
  ["beats", "Show the Story Beats"],
  ["quests", "Show the Quest Log"],
  ["twists", "Show the Twists (reading ahead)"],
  ["status", "Show Status: turns, Luck Points, leaves"],
];

/** Every terminal play command, in the order /help lists them. */
const SPECS: readonly Spec[] = [
  {
    names: ["help"],
    usage: "/help",
    help: "List every command",
    parse: none({ kind: "help" }),
  },
  {
    names: ["stop"],
    usage: "/stop",
    help: "Stop the Game Master; keep its reply so far (Ctrl+C)",
    parse: none({ kind: "stop" }),
  },
  {
    names: ["answer"],
    usage: "/answer",
    help: "Cut a local Game Master's thinking short: answer now",
    when: "answer",
    parse: none({ kind: "answer" }),
  },
  {
    names: ["retry"],
    usage: "/retry",
    help: "Play the latest Turn again, or an unanswered line",
    parse: (rest) =>
      !rest
        ? { kind: "retry", scratch: false }
        : rest === "scratch"
          ? { kind: "retry", scratch: true }
          : null,
  },
  // help only: `/retry scratch` parses as /retry
  {
    names: ["retry scratch"],
    usage: "/retry scratch",
    help: "Edit the latest Scratch thinking, then retry from it",
    when: "scratch",
    parse: () => null,
  },
  {
    names: ["edit"],
    usage: "/edit [turn]",
    help: "Edit the latest line, or a Game Master Turn",
    parse: optionalTurn("edit"),
  },
  {
    names: ["delete"],
    usage: "/delete",
    help: "Delete the latest Turn (Rewinds the Campaign)",
    parse: none({ kind: "delete" }),
  },
  {
    names: ["continue"],
    usage: "/continue [turn]",
    help: "Rewind to a Game Master Turn and let it carry on",
    parse: optionalTurn("continue"),
  },
  {
    names: ["history"],
    usage: "/history",
    help: "List earlier Turns to Continue from",
    parse: none({ kind: "history" }),
  },
  {
    names: ["scratch"],
    usage: "/scratch [turn]",
    help: "Show or hide a Turn's Scratch",
    parse: optionalTurn("scratch"),
  },
  {
    names: ["luck"],
    usage: "/luck",
    help: "Arm or disarm a Luck Point for the next roll",
    parse: none({ kind: "luck" }),
  },
  {
    names: ["rolls"],
    usage: "/rolls",
    help: "Show the Roll Log, newest first",
    parse: none({ kind: "rolls" }),
  },
  ...LEAVES.map(
    ([target, help]): Spec => ({
      names: [target],
      usage: `/${target}`,
      help,
        parse: none({ kind: "leaf", target }),
    }),
  ),
  {
    names: ["dossiers"],
    usage: "/dossiers [seek words]",
    help: "List Dossiers, or seek them by name or phrase",
    parse: (rest) => ({ kind: "dossiers", query: rest, archives: false }),
  },
  {
    names: ["archives"],
    usage: "/archives",
    help: "List Dossiers with the Archives open",
    parse: none({ kind: "dossiers", query: "", archives: true }),
  },
  {
    names: ["dossier"],
    usage: "/dossier <slug>",
    help: "Open one Dossier",
    parse: oneWord((slug) => ({ kind: "dossier", slug })),
  },
  {
    names: ["ink"],
    usage: "/ink",
    help: "Write the open leaf (Ctrl+S sets it)",
    parse: none({ kind: "ink" }),
  },
  {
    names: ["new"],
    usage: "/new <name>",
    help: "Enter a new Dossier",
    parse: (rest) => (rest ? { kind: "new", name: rest } : null),
  },
  {
    names: ["archive"],
    usage: "/archive [slug]",
    help: "Archive a Dossier (the open one by default)",
    parse: (rest) =>
      !rest
        ? { kind: "archive", archive: true }
        : /\s/u.test(rest)
          ? null
          : { kind: "archive", slug: rest, archive: true },
  },
  {
    names: ["restore"],
    usage: "/restore [slug]",
    help: "Bring an archived Dossier back",
    parse: (rest) =>
      !rest
        ? { kind: "archive", archive: false }
        : /\s/u.test(rest)
          ? null
          : { kind: "archive", slug: rest, archive: false },
  },
  {
    names: ["illustrate"],
    usage: "/illustrate [prompt]",
    help: "Paint the latest Game Master line",
    when: "illustrate",
    parse: (rest) => (rest ? { kind: "illustrate", prompt: rest } : { kind: "illustrate" }),
  },
  {
    names: ["keep"],
    usage: "/keep <1-4>",
    help: "Keep one painted sitting",
    when: "illustrate",
    parse: (rest) => {
      const slot = slot1to4(rest);
      return slot === null ? null : { kind: "keep", slot };
    },
  },
  {
    names: ["look"],
    usage: "/look [1-4]",
    help: "Open a sitting, or the latest picture, in your viewer",
    parse: (rest) => {
      if (!rest) return { kind: "look" };
      const slot = slot1to4(rest);
      return slot === null ? null : { kind: "look", slot };
    },
  },
  {
    names: ["cancel"],
    usage: "/cancel",
    help: "Put the brush down without keeping a sitting",
    when: "illustrate",
    parse: none({ kind: "cancel" }),
  },
  {
    names: ["light"],
    usage: "/light",
    help: "Memory Hygiene: catch up the beats and quest log",
    parse: none({ kind: "hygiene", mode: "light" }),
  },
  {
    names: ["heavy"],
    usage: "/heavy",
    help: "Memory Hygiene: tidy and compress the Campaign",
    parse: none({ kind: "hygiene", mode: "heavy" }),
  },
  {
    names: ["compact"],
    usage: "/compact",
    help: "Tidy, then restart the Game Master with a recent tail",
    parse: none({ kind: "hygiene", mode: "compact" }),
  },
  {
    names: ["fresh"],
    usage: "/fresh",
    help: "Tidy, then restart the Game Master with no dialogue",
    parse: none({ kind: "hygiene", mode: "fresh" }),
  },
  {
    names: ["settings"],
    usage: "/settings",
    help: "Show this adventure's play settings",
    parse: none({ kind: "settings" }),
  },
  {
    names: ["set"],
    usage: "/set <key> <value>",
    help: "Change a play setting (see /settings)",
    parse: (rest) => {
      const m = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(rest);
      return m ? { kind: "set", key: m[1]!, value: m[2] ?? "" } : null;
    },
  },
  {
    names: ["log"],
    usage: "/log [engine|host]",
    help: "Show the latest local AI log",
    when: "diagnostics",
    parse: (rest) =>
      !rest || rest === "engine"
        ? { kind: "log", source: "engine" }
        : rest === "host"
          ? { kind: "log", source: "host" }
          : null,
  },
  {
    names: ["quit", "exit", "leave", "bye"],
    usage: "/quit",
    help: "Leave for Home (also /exit, /leave, /bye)",
    parse: none({ kind: "quit" }),
  },
];

const BY_NAME = new Map<string, Spec>();
for (const spec of SPECS) {
  for (const name of spec.names) if (!name.includes(" ")) BY_NAME.set(name, spec);
}

/** The command a typed line names, or null when the line is not a command. */
export function parseSlash(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const m = /^\/(\S+)\s*([\s\S]*)$/u.exec(trimmed);
  const spec = m ? BY_NAME.get(m[1]!.toLowerCase()) : undefined;
  if (!spec) return { kind: "unknown" };
  return spec.parse(m![2]!.trim()) ?? { kind: "usage", usage: spec.usage };
}

/**
 * Commands that still run while the Game Master or the painter works: Stop,
 * Answer now, the brush's own controls, and reading (never writing).
 */
const WHILE_BUSY: ReadonlySet<SlashCommand["kind"]> = new Set([
  "help",
  "stop",
  "answer",
  "rolls",
  "leaf",
  "dossiers",
  "dossier",
  "keep",
  "look",
  "cancel",
  "settings",
  "log",
  "usage",
  "unknown",
]);

export function allowedWhileBusy(cmd: SlashCommand): boolean {
  return WHILE_BUSY.has(cmd.kind);
}

/** What /help lists, given what this Game Master and machine can do. */
export function helpLines(can: {
  answer: boolean;
  scratch: boolean;
  illustrate: boolean;
  diagnostics: boolean;
}): string[] {
  const shown = SPECS.filter((spec) => !spec.when || can[spec.when]);
  const width = Math.max(...shown.map((spec) => spec.usage.length));
  return shown.map((spec) => `${spec.usage.padEnd(width)}  ${spec.help}`);
}
