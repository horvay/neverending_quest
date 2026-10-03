#!/usr/bin/env bun
import {
  defaultConfigPath,
  loadConfigFile,
  mergeConfig,
  parseArgv,
  type NqConfig,
} from "./config.ts";
import type { AgentSessionFactory } from "./play/index.ts";
import { startSealedTransport } from "@nq/seal/client.ts";
import { runDelete, runNew, runShow } from "./cli/campaign.ts";
import { runLocal } from "./cli/local.ts";
import { runLogin } from "./cli/login.ts";
import { runPlay, runServeCmd, runTurn } from "./cli/play.ts";

export type MainOptions = {
  /** Stops a long-running command (`serve`) for in-process callers. */
  signal?: AbortSignal;
  /** The Game Master's model is external; in-process tests inject a scripted one. */
  agentFactory?: AgentSessionFactory;
};

export async function main(
  argv: string[],
  opts: MainOptions = {},
): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.help || !parsed.command) {
    printHelp();
    return 0;
  }

  const file = await loadConfigFile(parsed.flags.configPath);
  const config = mergeConfig(file, parsed.flags);

  const sealed =
    config.sealed && SEALED_COMMANDS.has(parsed.command)
      ? await startSealedTransport(config.sealed)
      : undefined;
  try {
    return await dispatch(parsed, config, opts);
  } finally {
    sealed?.stop();
  }
}

/** Commands that can talk to a Game Master, so need the sealed proxy up. */
const SEALED_COMMANDS = new Set(["turn", "play", "serve"]);

async function dispatch(
  parsed: ReturnType<typeof parseArgv>,
  config: NqConfig,
  opts: MainOptions,
): Promise<number> {
  switch (parsed.command) {
    case "login":
      return runLogin(
        parsed.rest,
        parsed.flags.configPath ?? defaultConfigPath(),
        parsed.flags.model,
      );
    case "local":
      return runLocal(
        parsed.rest,
        parsed.flags.model,
        parsed.flags.port,
        parsed.flags.configPath ?? defaultConfigPath(),
        opts.signal,
      );
    case "new":
      return runNew(parsed.rest);
    case "delete":
    case "rm":
      return runDelete(parsed.rest);
    case "show":
      return runShow(parsed.rest);
    case "turn":
      return runTurn(
        parsed.rest,
        config,
        opts.agentFactory,
        parsed.flags.configPath ?? defaultConfigPath(),
      );
    case "play":
      return runPlay(
        parsed.rest,
        config,
        parsed.flags.configPath ?? defaultConfigPath(),
        opts.agentFactory,
      );
    case "serve":
      return runServeCmd(
        parsed.rest,
        config,
        parsed.flags.openBrowser === true,
        parsed.flags.configPath ?? defaultConfigPath(),
        opts.signal,
        opts.agentFactory,
      );
    default:
      console.error(`Unknown command: ${parsed.command}`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  console.log(`nq — Neverending Quest

Usage:
  nq login [--provider <id>]
  nq local inspect <path|url|owner/repository>
  nq local download --model <path|url|owner/repository> [--model-file <file>]
  nq local install [--model <path|url|owner/repository>] [--backend <name>]
  nq local install --engine exl3xpu
  nq local start [--port <n>] [--ctx <tokens>] [--reasoning-tokens <n>]
  nq local status [--json]
  nq local stop
  nq local uninstall [--yes]
  nq local share [--listen <port>] [--keys]   # lend this computer's Game Master to the hosted book
  nq new <path> --pack <dir> [--name <display-name>]
  nq delete [path] [--yes]   # confirm with y/N; --yes skips prompt
  nq show [path] [target]
  nq turn [path] [-p text]
  nq play [path]             # Home, or play if a Campaign is given
  nq serve [path]            # localhost Home / book
  bun run watch [-- serve args]  # serve, rebuild book on save, reload tab

show targets: status | sheet | world | dossiers [slug] | beats | quests | twists | transcript

local model options:
  --model <source>       Local GGUF path, HTTP(S) URL, or Hugging Face repo URL/id
  --model-file <file>    GGUF filename when a Hugging Face repository has choices
  --model-sha256 <hash>  Required for URLs that do not publish a SHA-256 digest
  --mtp <source>         Optional MTP GGUF using the same source forms
  --mtp-file <file>      MTP filename when its repository has choices
  --mtp-sha256 <hash>    MTP checksum for an arbitrary URL
  --alias <id>           Model id shown by NQ and llama.cpp
  --backend <name>       auto, cpu, vulkan, cuda-12.4, cuda-13.3, rocm, or metal
  --engine exl3xpu       install the engine that runs EXL3 models on Intel Arc (~8 GB)
  --release <tag>        Atomic release tag (default b10269-1.5.1)
  --reasoning-tokens <n>  Thinking budget (default -1; unrestricted)

Run nq login to pin the Game Master model in NQ config; OMP's default model does not affect play.

Global flags:
  -d, --debug          Full agent event dump on stderr
  --log <path>         Mirror events to a log file
  --timeout <sec>      Turn inactivity timeout (default 180)
  --model <id|source>  Model id for play/turn; model source for local inspect/install
  --hygiene-n <n>      Light hygiene interval and compact tail in Turns (default 10)
  --compact-ceiling <n>
                       Rebuild-compaction ceiling in tokens (default 30000; a local
                       model keeps it at most 80% of its context)
  --max-tokens <n>     Most a llama.cpp Game Master writes per call (default 8192)
  --compact-seed-percent <n>
                       Percent of the ceiling a rebuilt session may occupy (default 50)
  --tail <n>           play/serve: transcript rows on open (default 20)
  --full               play/serve: show full transcript on open
  --port <n>           serve port, or local llama.cpp port (defaults 7737 / 8080)
  --host <addr>        serve bind address (default 127.0.0.1; 0.0.0.0 = whole LAN)
  --open               serve: open a system browser
  --gm-voice <path>    Global Game Master voice file (prepended to every system prompt)
  --reasoning <level>  Play thinking effort (default low)
  --config <path>      Config file (default XDG ~/.config/nq/config.toml)

Exit codes: 0 ok / clean quit; 1 error or Turn FAIL; 130 SIGINT on turn.

Two processes on one Campaign are last-writer-wins (no lock file).
`);
}

if (import.meta.main) {
  const code = await main(process.argv);
  process.exit(code);
}
