import { stdin as stdinStream } from "node:process";
import { createOmpAgentFactory } from "../agent/omp/factory.ts";
import { findCampaignPath } from "../campaign/index.ts";
import {
  createOmpReasoningCatalog,
  HomeSurface,
  prepareLocalGameMaster,
} from "../home/index.ts";
import { requireNqModel, type NqConfig } from "../config.ts";
import {
  MissingSeedError,
  PlayLoop,
  type AgentSessionFactory,
  type PlayEvent,
} from "../play/index.ts";
import { runPlay as runOpenTuiPlay } from "../surfaces/tui/run.ts";
import { runServe } from "../surfaces/web/serve.ts";
import { fakeTableFromEnv, type FakeTable } from "../dev/fake_table.ts";
import {
  loadLocalProfiles,
  profileFromConfig,
} from "../home/local_profiles.ts";
import { createRemoteWarmer } from "../agent/llama_cpp.ts";
import { createLocalInferenceHostClient } from "@nq/local-inference/host.ts";
import { fail } from "./fail.ts";
import { ceilingForLocalContext } from "../home/settings.ts";

export async function runTurn(
  args: string[],
  config: NqConfig,
  injected: AgentSessionFactory | undefined,
  configPath: string,
): Promise<number> {
  let pathArg: string | undefined;
  let playerText: string | undefined;
  let useStdin = true;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-p" || a === "--prompt") {
      playerText = args[++i] ?? "";
      useStdin = false;
      continue;
    }
    if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      return 1;
    }
    if (pathArg !== undefined) {
      console.error(`Unexpected argument: ${a}`);
      return 1;
    }
    pathArg = a;
  }

  if (useStdin && playerText === undefined) {
    if (!stdinStream.isTTY) {
      playerText = await readAllStdin();
    } else {
      playerText = "";
    }
  }

  const fake = injected ? null : fakeTableFromEnv();
  let factory: AgentSessionFactory;
  try {
    // the model's own engine profile, as the load page saved it
    const alias = config.model?.startsWith("llama.cpp/")
      ? config.model.slice("llama.cpp/".length)
      : undefined;
    const profile =
      (alias ? (await loadLocalProfiles(configPath))[alias] : undefined) ??
      profileFromConfig(config);
    // rebuild-compaction must come before the local engine's context runs out
    if (alias) {
      config.compactCeilingTokens = ceilingForLocalContext(
        config.compactCeilingTokens,
        profile.contextTokens,
      );
    }
    if (!fake) await prepareModelRuntime(config.model, {
      contextTokens: profile.contextTokens,
      reasoningTokens: profile.reasoningTokens,
      cacheK: profile.cacheK,
      cacheV: profile.cacheV,
      tuning: config.localTuning,
      kvOffload: profile.kvOffload,
      flashAttention: profile.flashAttention,
      ...(profile.gpu ? { gpu: profile.gpu } : {}),
      parallel: profile.parallel,
      ramCacheGiB: profile.ramCacheGiB,
      reasoning: config.reasoning,
      almanac: config.almanac,
    });
  } catch (err) {
    return fail(err);
  }
  try {
    factory = selectFactory(config, injected, fake);
  } catch (err) {
    return fail(err);
  }
  const loop = new PlayLoop({
    path: pathArg,
    factory,
    config,
    onEvent: (e: PlayEvent) => {
      if (config.debug && e.type === "agent_debug") {
        console.error(`[debug] ${JSON.stringify(e.event)}`);
      }
      if (e.type === "error") console.error(e.message);
      if (e.type === "status") console.error(e.message);
      if (e.type === "hygiene_started") console.error("Memory hygiene…");
    },
  });

  let exit = 0;
  const onSigInt = () => {
    loop.interrupt();
  };
  process.on("SIGINT", onSigInt);

  try {
    await loop.open();
    const result = await loop.turn(playerText ?? "");
    if (result.outcome === "success") {
      process.stdout.write(result.prose ?? "");
      if (result.prose && !result.prose.endsWith("\n"))
        process.stdout.write("\n");
      exit = result.stopped ? 130 : 0;
    } else if (result.reason === "interrupt") {
      console.error("Interrupted");
      exit = 130;
    } else {
      console.error(`Turn failed: ${result.reason ?? "unknown"}`);
      exit = 1;
    }
  } catch (err) {
    if (err instanceof MissingSeedError) {
      console.error(err.message);
      exit = 1;
    } else {
      exit = fail(err);
    }
  } finally {
    process.off("SIGINT", onSigInt);
    try {
      await loop.close();
    } catch {
      // ignore
    }
  }
  return exit;
}

type OpenedSurface = { surface: HomeSurface; path?: string };

/** `nq play` / `nq serve`: one optional Campaign path, then Home over it. */
async function openSurface(
  args: string[],
  config: NqConfig,
  configPath: string,
  injected?: AgentSessionFactory,
): Promise<OpenedSurface | number> {
  let pathArg: string | undefined;
  for (const a of args) {
    if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      return 1;
    }
    if (pathArg !== undefined) {
      console.error(`Unexpected argument: ${a}`);
      return 1;
    }
    pathArg = a;
  }
  const campaignPath = await findCampaignPath(pathArg);
  const fake = injected ? null : fakeTableFromEnv();
  let factory: AgentSessionFactory | undefined;
  if (campaignPath || injected || fake || config.model) {
    try {
      factory = selectFactory(config, injected, fake);
    } catch (err) {
      if (campaignPath) return fail(err);
      factory = undefined;
    }
  }
  if (factory && !fake && config.model) {
    process.stderr.write(`Game Master model: ${requireNqModel(config)}\n`);
  }
  return {
    surface: createHomeSurface(config, configPath, factory, injected, fake),
    ...(campaignPath ? { path: campaignPath } : {}),
  };
}

export async function runPlay(
  args: string[],
  config: NqConfig,
  configPath: string,
  injected?: AgentSessionFactory,
): Promise<number> {
  const opened = await openSurface(args, config, configPath, injected);
  if (typeof opened === "number") return opened;
  return runOpenTuiPlay(opened.surface, { path: opened.path });
}

export async function runServeCmd(
  args: string[],
  config: NqConfig,
  openBrowser: boolean,
  configPath: string,
  signal?: AbortSignal,
  injected?: AgentSessionFactory,
): Promise<number> {
  const opened = await openSurface(args, config, configPath, injected);
  if (typeof opened === "number") return opened;
  return runServe(opened.surface, {
    path: opened.path,
    config,
    openBrowser,
    ...(signal ? { signal } : {}),
  });
}

function createHomeSurface(
  config: NqConfig,
  configPath: string,
  factory: AgentSessionFactory | undefined,
  injected: AgentSessionFactory | undefined,
  fake: FakeTable | null,
): HomeSurface {
  return new HomeSurface({
    config,
    configPath,
    factory,
    ...(fake
      ? { illustrator: fake.illustrator }
      : {
          illustrator: {
            paintBatch: async (args) => {
              await createLocalInferenceHostClient().illustrate(args);
            },
          },
          endReasoning: async () =>
            (await createLocalInferenceHostClient().endReasoning()).success,
          warmModel: (model: string | undefined) => void warmRemoteModel(model),
          prepareModel: (
            model: string | undefined,
            opts: Parameters<typeof prepareLocalGameMaster>[2],
          ) => prepareModelRuntime(model, opts),
        }),
    reasoningCatalog: createOmpReasoningCatalog(),
    makeFactory: (model) => selectFactory({ ...config, model }, injected, fake, config),
    openBrowser: async (url) => {
      await Bun.$`xdg-open ${url}`.quiet().nothrow();
    },
  });
}

export async function prepareModelRuntime(
  model: string | undefined,
  opts: Parameters<typeof prepareLocalGameMaster>[2] = {},
): Promise<void> {
  await prepareLocalGameMaster(createLocalInferenceHostClient(), model, opts);
}

const warmRemoteModel = createRemoteWarmer();

/** An injected Game Master (tests), the dev fake table, or OMP on the model. */
function selectFactory(
  config: NqConfig,
  injected: AgentSessionFactory | undefined,
  fake: FakeTable | null,
  /** The config Home keeps current, read on every call for live settings. */
  live: NqConfig = config,
): AgentSessionFactory {
  if (injected) return injected;
  if (fake) return fake.factory;
  return createOmpAgentFactory({
    model: requireNqModel(config),
    searchFullModel: config.searchFullModel,
    searchFullReasoning: config.searchFullReasoning,
    thinkingLevel: config.reasoning,
    localThinkingOpener: config.localThinkingOpener,
    maxTokens: () => live.maxTokens,
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdinStream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
}
