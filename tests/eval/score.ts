import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadPlayState,
  readTranscript,
  type PlayState,
  type TranscriptRow,
} from "../../src/campaign/index.ts";
import { CANARY, MEMORY_GYM_DOSSIERS } from "./canaries.ts";
import {
  estimateTranscriptTokens,
  LONG_SESSION_MIN_TOKENS,
} from "./long_session.ts";

export type EvalScenario = "light" | "heavy" | "compact" | "long";

const ALL_LIVE: EvalScenario[] = ["light", "heavy", "compact", "long"];
const HEAVYISH: EvalScenario[] = ["heavy", "compact", "long"];
const COMPACTISH: EvalScenario[] = ["compact", "long"];

export type ScoreCheck = {
  id: string;
  description: string;
  hard: boolean;
  scenarios: EvalScenario[];
  pass: boolean;
  detail?: string;
};

export type ScoreContext = {
  campaign: string;
  scenario: EvalScenario;
  sheet: string;
  world: string;
  beats: string;
  quests: string;
  dossiers: Record<string, string>;
  playState: PlayState;
  transcript: TranscriptRow[];
  probeProse?: string;
  seedMessages?: Array<{ role: string; content: string }>;
  compactOk?: boolean;
};

export type ScoreResult = {
  scenario: EvalScenario;
  checks: ScoreCheck[];
  hardFailed: ScoreCheck[];
  softFailed: ScoreCheck[];
  passed: ScoreCheck[];
  ok: boolean;
};

export async function loadScoreContext(
  campaign: string,
  scenario: EvalScenario,
  extra?: Partial<
    Pick<ScoreContext, "probeProse" | "seedMessages" | "compactOk">
  >,
): Promise<ScoreContext> {
  const dossiers: Record<string, string> = {};
  const dir = path.join(campaign, "dossiers");
  const names = await readdir(dir);
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    dossiers[name] = await readFile(path.join(dir, name), "utf8");
  }
  return {
    campaign,
    scenario,
    sheet: await readFile(path.join(campaign, "player_sheet.md"), "utf8"),
    world: await readFile(path.join(campaign, "world-building.md"), "utf8"),
    beats: await readFile(path.join(campaign, "story-beats.md"), "utf8"),
    quests: await readFile(path.join(campaign, "quest-log.md"), "utf8"),
    dossiers,
    playState: await loadPlayState(campaign),
    transcript: await readTranscript(campaign),
    ...extra,
  };
}

export async function scoreCampaign(
  campaign: string,
  scenario: EvalScenario,
  extra?: Partial<
    Pick<ScoreContext, "probeProse" | "seedMessages" | "compactOk">
  >,
): Promise<ScoreResult> {
  return scoreContext(await loadScoreContext(campaign, scenario, extra));
}

export function scoreContext(ctx: ScoreContext): ScoreResult {
  const checks = allChecks()
    .filter((c) => c.scenarios.includes(ctx.scenario))
    .map((c) => c.run(ctx));

  const hardFailed = checks.filter((c) => c.hard && !c.pass);
  const softFailed = checks.filter((c) => !c.hard && !c.pass);
  const passed = checks.filter((c) => c.pass);
  return {
    scenario: ctx.scenario,
    checks,
    hardFailed,
    softFailed,
    passed,
    ok: hardFailed.length === 0,
  };
}

type CheckDef = {
  id: string;
  description: string;
  hard: boolean;
  scenarios: EvalScenario[];
  run: (ctx: ScoreContext) => ScoreCheck;
};

function allChecks(): CheckDef[] {
  return [
    check(
      "hygiene-status-ok",
      "play_state records a successful hygiene pass",
      true,
      ALL_LIVE,
      (ctx) => {
        const ok = ctx.playState.last_hygiene_status === "ok";
        return [
          ok,
          `status=${ctx.playState.last_hygiene_status ?? "unset"} mode=${ctx.playState.last_hygiene_mode ?? "unset"}`,
        ];
      },
    ),
    check(
      "hygiene-mode",
      "hygiene mode matches the scenario (compact uses heavy)",
      true,
      ALL_LIVE,
      (ctx) => {
        const expected = ctx.scenario === "light" ? "light" : "heavy";
        const ok = ctx.playState.last_hygiene_mode === expected;
        return [ok, `expected ${expected}`];
      },
    ),
    check(
      "no-hygiene-in-transcript",
      "hygiene assistant text is not a GM transcript row",
      true,
      ALL_LIVE,
      (ctx) => {
        const leak = ctx.transcript.some(
          (r) =>
            r.role === "gm" &&
            (r.text.includes("Memory Hygiene") ||
              r.text.includes("[Memory Hygiene")),
        );
        return [!leak];
      },
    ),
    check(
      "sheet-has-powers-h2",
      "Player Sheet still has a ## Powers heading",
      true,
      ALL_LIVE,
      (ctx) => [/^##\s+Powers\s*$/m.test(ctx.sheet)],
    ),
    check(
      "salt-lung-on-powers",
      "Salt-lung is recorded and not only parked under Notes",
      true,
      ALL_LIVE,
      (ctx) => {
        const powers = sectionBody(ctx.sheet, "Powers");
        const notes = sectionBody(ctx.sheet, "Notes");
        const inPowers = includesCI(powers, CANARY.power);
        const onlyNotes =
          !inPowers && includesCI(notes, CANARY.power);
        return [inPowers, onlyNotes ? "Salt-lung still only in Notes" : undefined];
      },
    ),
    check(
      "token-on-sheet",
      "seven-eyed token or CANARY-BELL-7E landed on the Player Sheet",
      true,
      ALL_LIVE,
      (ctx) => {
        const hit =
          includesCI(ctx.sheet, CANARY.stamp) ||
          includesCI(ctx.sheet, CANARY.token);
        return [hit];
      },
    ),
    check(
      "beats-catch-up",
      "Story Beats mention the token, stamp, Mira, or well find",
      true,
      ALL_LIVE,
      (ctx) => {
        const hit =
          includesCI(ctx.beats, CANARY.stamp) ||
          includesCI(ctx.beats, CANARY.token) ||
          includesCI(ctx.beats, "token") ||
          includesCI(ctx.beats, CANARY.mira) ||
          includesCI(ctx.beats, CANARY.well);
        return [hit, `beats=${truncate(ctx.beats, 160)}`];
      },
    ),
    check(
      "beats-append-only",
      "pre-existing Story Beat lines are still present",
      true,
      ALL_LIVE,
      (ctx) => [
        ctx.beats.includes("Ren arrive Brinewatch dock") &&
          ctx.beats.includes("Mira give Ren a room"),
      ],
    ),
    check(
      "lemon-quest-gone",
      "resolved lemon errand is deleted from the Quest Log",
      true,
      ALL_LIVE,
      (ctx) => [!includesCI(ctx.quests, CANARY.lemon)],
    ),
    check(
      "bell-quest-open",
      "drowned-bell lead remains on the Quest Log",
      true,
      ALL_LIVE,
      (ctx) => [includesLoose(ctx.quests, CANARY.bellQuest)],
    ),
    check(
      "dossiers-not-deleted",
      "eval dossiers still exist (never-delete)",
      true,
      ALL_LIVE,
      (ctx) => {
        const missing = MEMORY_GYM_DOSSIERS.filter((name) => !(name in ctx.dossiers));
        return [missing.length === 0, missing.length ? missing.join(", ") : undefined];
      },
    ),
    check(
      "mira-alias-or-body",
      "Mira's Aunt Salt name is recorded on her dossier",
      false,
      ALL_LIVE,
      (ctx) => {
        const body = ctx.dossiers["mira-venn.md"] ?? "";
        return [includesCI(body, CANARY.aunt)];
      },
    ),
    check(
      "choir-fact-kept",
      "Tide Choir fog-neap fact still in World-Building",
      true,
      ALL_LIVE,
      (ctx) => [includesCI(ctx.world, "Tide Choir")],
    ),
    check(
      "kell-merged-stub",
      "duplicate Kell dossiers merged to keeper + stub_of",
      true,
      HEAVYISH,
      (ctx) => {
        const a = ctx.dossiers["kell.md"] ?? "";
        const b = ctx.dossiers["kell-reed.md"] ?? "";
        const aStub = hasStubOf(a);
        const bStub = hasStubOf(b);
        const ok = aStub !== bStub && (aStub || bStub);
        return [
          ok,
          `kell.md stub=${aStub} kell-reed.md stub=${bStub}`,
        ];
      },
    ),
    check(
      "world-deduped",
      "Tide Choir is no longer copy-pasted three times",
      false,
      HEAVYISH,
      (ctx) => {
        const n = countCI(ctx.world, "Tide Choir only sings");
        return [n <= 1, `occurrences=${n}`];
      },
    ),
    check(
      "compact-event-ok",
      "rebuild-compaction finished successfully",
      true,
      COMPACTISH,
      (ctx) => [ctx.compactOk === true],
    ),
    check(
      "tail-dropped-stamp",
      "compact seed tail does not still contain CANARY-BELL-7E",
      true,
      COMPACTISH,
      (ctx) => {
        const msgs = ctx.seedMessages ?? [];
        const leaked = msgs.some((m) => includesCI(m.content, CANARY.stamp));
        return [!leaked, leaked ? "stamp still in seedMessages" : undefined];
      },
    ),
    check(
      "probe-recalls-stamp",
      "post-compact probe Turn names CANARY-BELL-7E",
      true,
      COMPACTISH,
      (ctx) => {
        const prose = ctx.probeProse ?? "";
        return [includesCI(prose, CANARY.stamp), truncate(prose, 200)];
      },
    ),
    check(
      "transcript-min-tokens",
      `player-facing transcript is at least ${LONG_SESSION_MIN_TOKENS} tokens`,
      true,
      ["long"],
      (ctx) => {
        const n = estimateTranscriptTokens(ctx.transcript);
        return [n >= LONG_SESSION_MIN_TOKENS, `tokens=${n}`];
      },
    ),
    check(
      "ledger-recorded",
      "Mira's CANARY-LEDGER-19 cipher landed on a dossier or the sheet",
      false,
      ["long"],
      (ctx) => {
        const hay = [
          ctx.sheet,
          ctx.world,
          ctx.beats,
          ...Object.values(ctx.dossiers),
        ].join("\n");
        return [includesCI(hay, CANARY.ledger)];
      },
    ),
  ];
}

function check(
  id: string,
  description: string,
  hard: boolean,
  scenarios: EvalScenario[],
  run: (ctx: ScoreContext) => [boolean, string?] ,
): CheckDef {
  return {
    id,
    description,
    hard,
    scenarios,
    run: (ctx) => {
      const [pass, detail] = run(ctx);
      return { id, description, hard, scenarios, pass, detail };
    },
  };
}

function includesCI(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

/** Match "drowned bell" against "drowned-bell" / "drownedbell". */
function includesLoose(hay: string, needle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  return norm(hay).includes(norm(needle));
}

function countCI(hay: string, needle: string): number {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let from = 0;
  while (from <= h.length) {
    const i = h.indexOf(n, from);
    if (i < 0) break;
    count += 1;
    from = i + n.length;
  }
  return count;
}

function hasStubOf(body: string): boolean {
  return /^stub_of\s*:/m.test(body);
}

function sectionBody(sheet: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const start = sheet.search(re);
  if (start < 0) return "";
  const after = sheet.slice(start).split("\n").slice(1);
  const lines: string[] = [];
  for (const line of after) {
    if (/^##\s+/.test(line)) break;
    lines.push(line);
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}
