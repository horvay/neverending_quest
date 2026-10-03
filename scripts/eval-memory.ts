#!/usr/bin/env bun
/**
 * Opt-in live Memory Hygiene / rebuild-compaction eval.
 *
 * Births tests/eval/packs/memory-gym, overlays the dirty midgame fixture, then runs
 * Grok (or `--model`) through PlayLoop eval hooks. Scoring is canary
 * greps on Campaign files — not a second-model judge.
 *
 *   bun run eval:memory -- --model xai-oauth/grok-4.6
 *   bun run eval:memory -- --model xai-oauth/grok-4.6 --scenario compact
 *   bun run eval:memory -- --model xai-oauth/grok-4.6 --scenario long
 *   bun run eval:memory -- --model xai-oauth/grok-4.6 --keep-campaign /tmp/gym
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createOmpAgentFactory } from "../src/agent/omp/factory.ts";
import { PlayLoop, type PlayEvent, type SessionCreateOptions } from "../src/play/index.ts";
import {
  birthDirtyMemoryGym,
  birthLongBrinewatch,
} from "../tests/eval/apply_fixture.ts";
import { PROBE_QUESTION } from "../tests/eval/canaries.ts";
import {
  scoreCampaign,
  type EvalScenario,
  type ScoreResult,
} from "../tests/eval/score.ts";

const DEFAULT_MODEL = "xai-oauth/grok-4.6";

type Args = {
  model: string;
  scenario: EvalScenario | "all";
  keepCampaign?: string;
  timeoutSec: number;
};

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) return 2;

  const root = args.keepCampaign
    ? path.resolve(args.keepCampaign)
    : path.join(process.env.TMPDIR ?? "/tmp", `nq-eval-memory-${Date.now()}`);
  if (args.keepCampaign) {
    await mkdir(root, { recursive: true });
  }

  process.stderr.write(`Work dir: ${root}\n`);
  process.stderr.write(`Model: ${args.model}\n`);

  const scenarios: EvalScenario[] =
    args.scenario === "all" ? ["light", "heavy", "compact"] : [args.scenario];

  let failed = 0;
  try {
    for (const scenario of scenarios) {
      const result = await runScenario({
        campaignRoot: root,
        scenario,
        model: args.model,
        timeoutSec: args.timeoutSec,
      });
      printScore(result);
      if (!result.ok) failed += 1;
    }
  } finally {
    if (!args.keepCampaign) {
      await rm(root, { recursive: true, force: true });
    } else {
      process.stderr.write(`Kept Campaign tree under ${root}\n`);
    }
  }

  return failed === 0 ? 0 : 1;
}

async function runScenario(opts: {
  campaignRoot: string;
  scenario: EvalScenario;
  model: string;
  timeoutSec: number;
}): Promise<ScoreResult> {
  // Each scenario gets a fresh dirty Campaign so later scenarios do not
  // inherit a cleaned tree from an earlier pass.
  const stamp = `${opts.scenario}-${Date.now()}`;
  const isolated = path.join(opts.campaignRoot, stamp);
  await mkdir(isolated, { recursive: true });
  const long = opts.scenario === "long";
  const born = long ? await birthLongBrinewatch(isolated) : null;
  const campaign = born ? born.campaign : await birthDirtyMemoryGym(isolated);
  if (born) {
    process.stderr.write(
      `Long transcript: ${born.transcriptTokens} tokens, ${born.playerTurns} player turns\n`,
    );
  }

  const events: PlayEvent[] = [];
  let lastCreate: SessionCreateOptions | undefined;
  const factory = createOmpAgentFactory({ model: opts.model });
  const wrapped = {
    create: async (createOpts: SessionCreateOptions) => {
      lastCreate = createOpts;
      return factory.create(createOpts);
    },
    continueRecent: factory.continueRecent?.bind(factory),
  };

  const loop = new PlayLoop({
    path: campaign,
    factory: wrapped,
    config: {
      turnTimeoutMs: (long ? Math.max(opts.timeoutSec, 1800) : opts.timeoutSec) * 1000,
      hygieneN: 10,
      compactCeilingTokens: 128_000,
    },
    onEvent: (e) => {
      events.push(e);
      if (e.type === "status" || e.type === "error") {
        process.stderr.write(`${e.type}: ${e.message}\n`);
      } else if (e.type === "hygiene_started") {
        process.stderr.write(`hygiene_started ${e.mode}\n`);
      } else if (e.type === "hygiene_ended") {
        process.stderr.write(
          `hygiene_ended ${e.mode} ok=${e.ok}${e.error ? ` ${e.error}` : ""}\n`,
        );
      } else if (e.type === "compact_started") {
        process.stderr.write("compact_started\n");
      } else if (e.type === "compact_ended") {
        process.stderr.write(
          `compact_ended ok=${e.ok}${e.error ? ` ${e.error}` : ""}\n`,
        );
      }
    },
  });

  let probeProse: string | undefined;
  let compactOk: boolean | undefined;
  try {
    process.stderr.write(`\n=== ${opts.scenario} ===\n`);
    await loop.open();
    if (opts.scenario === "light") {
      await loop.runHygienePass("light");
    } else if (opts.scenario === "heavy") {
      await loop.runHygienePass("heavy");
    } else {
      // compact + long: heavy hygiene then rebuild-compaction + probe
      compactOk = await loop.runRebuildCompaction();
      if (compactOk) {
        const probe = await loop.turn(PROBE_QUESTION);
        probeProse = probe.prose;
        process.stderr.write(
          `probe outcome=${probe.outcome}${probe.prose ? `\n${probe.prose}\n` : ""}\n`,
        );
      }
    }
  } finally {
    try {
      await loop.close();
    } catch {
      // ignore
    }
  }

  void events;
  return scoreCampaign(campaign, opts.scenario, {
    probeProse,
    seedMessages: lastCreate?.seedMessages,
    compactOk,
  });
}

function printScore(result: ScoreResult): void {
  process.stdout.write(`\n${result.scenario}: ${result.ok ? "PASS" : "FAIL"}\n`);
  for (const c of result.checks) {
    const mark = c.pass ? "PASS" : c.hard ? "FAIL" : "SOFT";
    const detail = c.detail ? ` — ${c.detail}` : "";
    process.stdout.write(`  [${mark}] ${c.id}: ${c.description}${detail}\n`);
  }
  process.stdout.write(
    `${result.passed.length} passed, ${result.hardFailed.length} hard-failed, ${result.softFailed.length} soft-failed\n`,
  );
}

function parseArgs(argv: string[]): Args | null {
  const args: Args = {
    model: process.env.NQ_EVAL_MODEL?.trim() || DEFAULT_MODEL,
    scenario: "all",
    timeoutSec: Number(process.env.NQ_EVAL_TIMEOUT ?? 600),
  };
  const tokens = argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "-h" || t === "--help") {
      printHelp();
      return null;
    }
    if (t === "--model") {
      args.model = tokens[++i] ?? args.model;
      continue;
    }
    if (t === "--scenario") {
      const v = tokens[++i];
      if (
        v !== "light" &&
        v !== "heavy" &&
        v !== "compact" &&
        v !== "long" &&
        v !== "all"
      ) {
        console.error(`Unknown scenario: ${v}`);
        return null;
      }
      args.scenario = v;
      continue;
    }
    if (t === "--keep-campaign") {
      args.keepCampaign = tokens[++i];
      continue;
    }
    if (t === "--timeout") {
      args.timeoutSec = Number(tokens[++i]);
      continue;
    }
    console.error(`Unknown argument: ${t}`);
    printHelp();
    return null;
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: bun run scripts/eval-memory.ts [options]

  --model <id>           Game Master model (default: ${DEFAULT_MODEL})
  --scenario <name>      light | heavy | compact | long | all
                         (default: all = light+heavy+compact; long is opt-in)
  --keep-campaign <dir>  Keep birthed Campaigns under this directory
  --timeout <sec>        Per-prompt wall clock (default: 600)

Requires an OMP-logged-in provider that can serve the model id.
Not part of \`bun test\`.`);
}

const code = await main(process.argv);
process.exit(code);
