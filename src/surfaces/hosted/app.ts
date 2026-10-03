/**
 * The hosted book's "server", run inside the page: the same Home surface,
 * Play Loop and HTTP routes `nq serve` uses, turned into a web handler the
 * book's `fetch("/api/…")` calls reach in-process. Only the Game Master
 * differs — the hosted agent over the sealed relay — and, in the browser
 * build, the file system (OPFS).
 */
import { Headers, HttpApp, HttpRouter, HttpServerRequest } from "@effect/platform";
import { Effect, Layer } from "effect";
import { loadConfigFile, mergeConfig, type NqConfig } from "../../config.ts";
import { HomeSurface } from "../../home/surface.ts";
import { serveHttpApp } from "../web/http.ts";
import { homeHttpApp, homeServiceLayer, playSessionFromHome } from "../web/http_home.ts";
import { PlaySession } from "../../play/session.ts";
import { createHostedAgentFactory, type HostedAgentOptions } from "../../agent/browser/agent.ts";

export const HOSTED_PROVIDER_ID = "llama.cpp-runpod";
export const HOSTED_MODEL = `${HOSTED_PROVIDER_ID}/qwen`;
/**
 * On OpenRouter the Game Master is not our llama-server, so it is not named
 * as one: the Play Loop shows a thinking prefill only for llama.cpp models,
 * and OpenRouter never receives that prefill.
 */
const OPENROUTER_PROVIDER_ID = "openrouter";
const PAGE_HOST = "nq.hosted";
/**
 * The public book keeps the Game Master's context small and fixed: a smaller
 * prompt is a cheaper, faster Turn on the rented GPU, and players do not tune it.
 */
export const HOSTED_CONTEXT_CEILING = 30_000;
/**
 * How much of the ceiling a session rebuilt from scratch (reload, Edit,
 * Rewind, compaction) may fill with pins plus replayed recent Turns. Turns
 * themselves always run up to the full ceiling.
 */
export const HOSTED_SEED_PERCENT = 70;
/** Thinking cap per call on the public book: enough to plan a reply, cheap on the GPU. */
export const HOSTED_THINKING_TOKENS = 1_000;
/** Output limit per call on the public book: players cannot raise the GPU spend. */
export const HOSTED_MAX_TOKENS = 8_192;
/**
 * Where the Game Master's thinking starts. A numbered "step by step" opener
 * invited invented recaps; anchoring on the player's actual words does not.
 */
export const HOSTED_THINKING_OPENER = "First, exactly what the player just said or did:";

export type HostedAppOptions = {
  agent: HostedAgentOptions;
  /** Holds `config.toml` (settings) and `campaigns/`. */
  dataDir: string;
  /** Read-only Seed Packs. */
  packsDir: string;
};

export type HostedApp = {
  handler: (request: Request) => Promise<Response>;
  home: HomeSurface;
  dispose: () => Promise<void>;
};

export async function createHostedApp(opts: HostedAppOptions): Promise<HostedApp> {
  const configPath = `${opts.dataDir}/config.toml`;
  const file = await loadConfigFile(configPath);
  const openai = opts.agent.dialect === "openai";
  const providerId = openai ? OPENROUTER_PROVIDER_ID : HOSTED_PROVIDER_ID;
  const modelName = opts.agent.modelId ?? (openai ? "game-master" : "qwen");
  const model = openai ? `${providerId}/${modelName}` : HOSTED_MODEL;
  const config: NqConfig = { ...mergeConfig(file, {}), model };
  // the player may still set their own opener in Settings
  config.localThinkingOpener ||= HOSTED_THINKING_OPENER;
  const factory = createHostedAgentFactory({
    ...opts.agent,
    thinkingOpener: opts.agent.thinkingOpener ?? config.localThinkingOpener,
    // a per-request thinking cap is our llama-server's; OpenRouter gets low effort instead
    ...(opts.agent.dialect === "openai"
      ? {}
      : { reasoningBudgetTokens: opts.agent.reasoningBudgetTokens ?? HOSTED_THINKING_TOKENS }),
    // Settings saves update this same config object
    reasoning: opts.agent.reasoning ?? (() => config.reasoning),
    maxTokens: opts.agent.maxTokens ?? (() => config.maxTokens),
  });
  const home = new HomeSurface({
    config,
    configPath,
    packsDir: opts.packsDir,
    campaignsDir: `${opts.dataDir}/campaigns`,
    // the relay decides the one Game Master; players do not choose
    gameMaster: {
      provider: "Neverending Quest",
      model,
      name: openai || opts.agent.modelId ? modelName : "Qwen",
    },
    factory,
    makeFactory: () => factory,
    probeLocal: async () => false,
    // no pre-wake: a keystroke must not start a paid GPU worker
    warmModel: () => {},
    fixedSettings: {
      compactCeilingTokens: HOSTED_CONTEXT_CEILING,
      compactSeedPercent: HOSTED_SEED_PERCENT,
      maxTokens: HOSTED_MAX_TOKENS,
    },
    // no debug logging, log files or AI log on the public book
    diagnostics: false,
  });

  const routes = HttpRouter.concat(homeHttpApp, serveHttpApp);
  const layer = Layer.mergeAll(
    Layer.succeed(PlaySession, playSessionFromHome(home)),
    homeServiceLayer(home),
  );
  // The page is the only client, so every request is same-origin by
  // construction. Browsers drop `Origin`/`Host` on a Request built in script,
  // so stamp them for the routes' CSRF guard.
  const samePage = Effect.flatMap(HttpServerRequest.HttpServerRequest, (req) =>
    Effect.provideService(
      routes,
      HttpServerRequest.HttpServerRequest,
      req.modify({
        headers: Headers.setAll(req.headers, { host: PAGE_HOST, origin: `http://${PAGE_HOST}` }),
      }),
    ),
  );
  const { handler, dispose } = HttpApp.toWebHandlerLayer(samePage, layer);
  return {
    handler: (request) => handler(request),
    home,
    dispose,
  };
}
