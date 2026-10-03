import { estimateTokensDefault } from "../../src/play/context.ts";
import type { TranscriptRow } from "../../src/campaign/index.ts";
import { CANARY } from "./canaries.ts";


/** Minimum player-facing transcript size for the long eval. */
export const LONG_SESSION_MIN_TOKENS = 40_000;

/**
 * Generate a transcript large enough to trigger compaction, with early facts
 * more than one default Hygiene interval from the end.
 */
export const LONG_SESSION_TARGET_TOKENS = 52_000;

const FORBIDDEN = [
  CANARY.stamp,
  CANARY.token,
  "seven-eyed",
  "CANARY-BELL",
  "CANARY-LEDGER",
];

const START = Date.parse("2026-03-01T08:00:00.000Z");

export type LongTranscript = {
  rows: TranscriptRow[];
  tokens: number;
  playerTurns: number;
};

export function estimateRowTokens(row: Pick<TranscriptRow, "role" | "text">): number {
  return estimateTokensDefault(`[${row.role}] ${row.text}`);
}

export function estimateTranscriptTokens(
  rows: Array<Pick<TranscriptRow, "role" | "text">>,
): number {
  return rows.reduce((n, r) => n + estimateRowTokens(r), 0);
}

export function generateLongTranscript(
  targetTokens: number = LONG_SESSION_TARGET_TOKENS,
): LongTranscript {
  const rows: TranscriptRow[] = [];
  let t = START;

  const push = (role: TranscriptRow["role"], text: string) => {
    rows.push({
      ts: new Date(t).toISOString(),
      role,
      text,
    });
    t += 90_000;
  };

  for (const [role, text] of earlyBeats()) {
    push(role, text);
  }

  let cycle = 0;
  while (estimateTranscriptTokens(rows) < targetTokens) {
    const [player, gm] = fillerPair(cycle);
    assertClean(player);
    assertClean(gm);
    push("player", player);
    push("gm", gm);
    cycle += 1;
    if (cycle > 10_000) {
      throw new Error("long transcript generator failed to reach token target");
    }
  }

  const tokens = estimateTranscriptTokens(rows);
  const playerTurns = rows.filter((r) => r.role === "player").length;
  return { rows, tokens, playerTurns };
}

export function serializeTranscript(rows: TranscriptRow[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function earlyBeats(): Array<["player" | "gm", string]> {
  return [
    [
      "gm",
      "Brinewatch is a single salt-stained dock and a tavern lamp. Gulls argue over the pilings. Mira Venn watches you from the Salt Lamp doorway. The ferry sits low. Behind the net racks the brine-well rope knocks its hook.",
    ],
    ["player", "I walk up and greet Mira."],
    [
      "gm",
      "Mira wipes her hands on her apron. Call me Aunt Salt if you want a tab, she says. The attic pallet is yours. She taps the book under the bar. Margin code CANARY-LEDGER-19, she adds, like she is naming a nail size, not a secret. Don't let Jess Pike see the page.",
    ],
    ["player", "I ask the ferryman his name and whether he can take me out at dusk."],
    [
      "gm",
      "The ferryman taps the spare oar under the bench. Kell Reed, he says. Not after dark, and not by the well path. Grey Spit tomorrow if the water is honest.",
    ],
    ["player", "I find Jess Pike at the dory house and ask about barrels for Mira."],
    [
      "gm",
      "Jess Pike has tar under her nails and a hoop half-set. Mira's lemon crate is on the list, she says. Holt Gann can wait for his slate box. She does not ask about the ledger code.",
    ],
    ["player", "I go to the brine-well and fish out the bright thing on the ledge."],
    [
      "gm",
      `Your hook lifts a ${CANARY.token}. The stamp on the face reads ${CANARY.stamp}. ${CANARY.power} keeps the well-gas out of your throat. Aunt Orren, mending two racks over, does not look up.`,
    ],
    ["player", "I buy Mira a lemon and hand it over."],
    [
      "gm",
      "Mira pockets the lemon, marks the errand done, and pours you a thimble of something sour. That tab item is closed. The book stays shut. CANARY-LEDGER-19 is not for the room.",
    ],
    ["player", "I ask Holt Gann about the singing last night."],
    [
      "gm",
      "Holt Gann sits the customs-post steps with his cracked ear-horn. Fog-neap, he says. The Tide Choir only sings on fog-neap nights. Weather, not a church. If you want a drowned bell, that is a rumor from Grey Spit, not a schedule.",
    ],
    ["player", "I help Aunt Orren with a net and ask what the well took."],
    [
      "gm",
      "Aunt Orren cusses your knots and takes the net anyway. A boy in her mother's year, she says. She will not name him. She nods at the racks. After dark they creak even without wind. Go sit. The dock will still be ugly tomorrow.",
    ],
  ];
}

function fillerPair(cycle: number): [string, string] {
  const day = Math.floor(cycle / 6) + 1;
  const tide = cycle % 2 === 0 ? "first tide" : "second tide";
  const weather = WEATHER[cycle % WEATHER.length]!;
  const chore = CHORES[cycle % CHORES.length]!;
  const extra = EXTRAS[cycle % EXTRAS.length]!;
  const player = PLAYERS[cycle % PLAYERS.length]!;

  const gm = [
    `Day ${day} on the Brinewatch dock, ${tide}, ${weather}.`,
    `${chore} ${extra}`,
    "Grey water slaps the pilings. A coil of line ticks a cleat. Gulls trade the same insults they used at dawn.",
    "The Salt Lamp lamp stays lit because Mira never puts it out before second tide. You smell pitch, wet rope, and yesterday's fry oil.",
    "The ferry sits low. The well path is out of sight behind the nets. No clerk comes to the customs desk. Holt's slate stays on the steps.",
    "Dock talk nearby is about nets, casks, and whether Grey Spit will send water this week. Nobody offers you a new name or a new job that would change the week.",
    `You count ${7 + (cycle % 5)} gulls, then one less, then the same again. Time stretches without adding a fact you would bother to write down.`,
    "Jess's hoop mallet ticks from the dory house. Aunt Orren's lean-to smokes eel skin or pretends to. A boy runs past with a message that is not for you.",
    "If there is a drowned bell it does not ring from here. The village is a loop of small sounds, and the loop does not teach you anything new.",
  ].join(" ");

  return [player, gm];
}

function assertClean(text: string): void {
  const lower = text.toLowerCase();
  for (const bad of FORBIDDEN) {
    if (lower.includes(bad.toLowerCase())) {
      throw new Error(`filler leaked canary ${bad}`);
    }
  }
}

const PLAYERS = [
  "I sit on the dock and wait.",
  "I mend spare line.",
  "I walk the dock from the post to the ferry and back.",
  "I drink a thimble at the Salt Lamp and listen.",
  "I watch the water.",
  "I help stack empty casks.",
  "I stay put.",
  "I check the ferry slip and come back.",
];

const WEATHER = [
  "a hard grey wind off the reach",
  "soft rain that never quite commits",
  "fog that thins and comes back meaner",
  "a bright cold that shows every stain on the planks",
  "overcast so even the gulls sound bored",
];

const CHORES = [
  "You coil someone else's line and leave it neater than you found it.",
  "You shift a crate that did not need shifting, then shift it back.",
  "You scrape bladderwrack off a piling with the belt knife and wipe the blade on your oilskin.",
  "You carry two empty casks for a Dock Hand who pays you a nod.",
  "You sit the lee of the customs wall until the rain decides.",
];

const EXTRAS = [
  "A cart of empty barrels rolls past, sticks, frees itself, and leaves rust water on the planks.",
  "Someone dumps a bucket far up-dock; the splash reaches you two breaths later.",
  "The tavern sign squeaks one note and back.",
  "A dory on blocks sheds a curl of oakum. Nobody claims it.",
  "Second tide lifts the ferry a handspan and sets it down like it changed its mind.",
];
