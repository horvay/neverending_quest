/**
 * The local Game Master: an `AgentSessionFactory` over the embedded OMP coding
 * agent (ADR-0002). This file opens sessions; the pieces live beside it:
 *
 *   tools.ts            custom game tools, tool scope and path-jail hooks
 *   local_shaping.ts    llama.cpp request shaping (thinking prefill, effort)
 *   provider_quirks.ts  live-model fixes for providers OMP gets wrong
 *   journal.ts          seed history, resume and hidden-history markers
 *   session_adapter.ts  OMP session → the Play Loop's AgentSession
 *   events.ts           OMP events → AgentSessionEvent
 */
import {
  createAgentSession,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
  parseConfiguredThinkingLevel,
  type ConfiguredThinkingLevel,
} from "@oh-my-pi/pi-coding-agent/thinking";
import {
  createSandbox,
  PLAY_TOOL_NAMES,
  type Sandbox,
} from "../../play/sandbox.ts";
import { playProviderSystemPrompt } from "../wire_shaping.ts";
import type {
  AgentSession,
  AgentSessionFactory,
  SessionCreateOptions,
} from "../../play/types.ts";
import { injectSeedMessages, openResumableJournal } from "./journal.ts";
import {
  createLocalThinkingPrefillExtension,
  createOutputCapExtension,
  type LocalModelShaping,
  type LocalPrefillGate,
} from "./local_shaping.ts";
import { fitLiveModel } from "./provider_quirks.ts";
import { adaptOmpSession } from "./session_adapter.ts";
import {
  BUILTIN_FS_TOOL_NAMES,
  buildCustomTools,
  createSandboxJailExtension,
  createToolScopeExtension,
  type ToolScope,
} from "./tools.ts";

/** OMP thinking selectors accepted for play. Unknown values fall back to low. */
export const DEFAULT_PLAY_THINKING_LEVEL = parseConfiguredThinkingLevel("low")!;

export function resolvePlayThinkingLevel(
  raw: string | undefined,
): ConfiguredThinkingLevel {
  const parsed = parseConfiguredThinkingLevel(raw?.trim().toLowerCase());
  if (parsed && parsed !== "inherit") return parsed;
  return DEFAULT_PLAY_THINKING_LEVEL;
}

export type OmpFactoryOptions = {
  model?: string;
  searchFullModel?: string;
  searchFullReasoning?: string;
  /** Game Master thinking effort. Default low. */
  thinkingLevel?: string;
  /** llama.cpp-only reasoning prefix continued inside the model's thinking block. */
  localThinkingOpener?: string;
  /**
   * Output cap per call for llama.cpp-family models, read on every request
   * so a change in Settings applies to the next call.
   */
  maxTokens?: () => number | undefined;
  /**
   * A ready model connection, used instead of resolving `model` through the
   * player's OMP registry. Tests put a scripted model behind the real adapter
   * this way, so everything above the model runs for real.
   */
  connection?: { model: Model<Api>; modelRegistry: ModelRegistry };
};

/**
 * Live factory backed by @oh-my-pi/pi-coding-agent@17.0.9.
 *
 * Note on allowlisting: OMP 17.0.9's `restrictToolNames: true` zeroes
 * `customTools` and skips caller `extensions` (sdk.ts). We therefore keep
 * restrict off, pass only FS builtins in `toolNames`, register roll/search/
 * search_full/archive as customTools + path-jail extension, disable discovery/MCP/LSP/
 * IRC, and pin the active set with `setActiveToolsByName` after create.
 */
export function createOmpAgentFactory(
  opts?: OmpFactoryOptions,
): AgentSessionFactory {
  return {
    async create(createOpts: SessionCreateOptions): Promise<AgentSession> {
      return buildSession({
        cwd: createOpts.cwd,
        sessionsDir: createOpts.sessionsDir,
        sessionManager: SessionManager.create(
          createOpts.cwd,
          createOpts.sessionsDir,
        ),
        systemPrompt: createOpts.systemPrompt,
        contextFiles: createOpts.contextFiles,
        seedMessages: createOpts.seedMessages,
        toolNames: createOpts.toolNames,
        offeredToolNames: createOpts.offeredToolNames,
        sandbox:
          createOpts.sandbox ??
          (await createSandbox({ campaignRoot: createOpts.cwd })),
        factoryOpts: opts,
        searchFullModel: createOpts.searchFullModel ?? opts?.searchFullModel,
        searchFullReasoning:
          createOpts.searchFullReasoning ?? opts?.searchFullReasoning,
      });
    },
    async continueRecent(cont): Promise<AgentSession | null> {
      try {
        const sm = await openResumableJournal(cont);
        if (!sm) return null;

        return await buildSession({
          cwd: cont.cwd,
          sessionsDir: cont.sessionsDir,
          sessionManager: sm,
          sandbox:
            cont.sandbox ?? (await createSandbox({ campaignRoot: cont.cwd })),
          factoryOpts: opts,
          systemPrompt: cont.systemPrompt,
          contextFiles: cont.contextFiles,
          offeredToolNames: cont.offeredToolNames,
          searchFullModel: opts?.searchFullModel,
          searchFullReasoning: opts?.searchFullReasoning,
        });
      } catch {
        return null;
      }
    },
  };
}

const PLAY_SETTINGS_OVERRIDES = {
  "compaction.enabled": false,
  "memory.backend": "off",
  "goal.enabled": false,
  // otherwise OMP adds its skill-writing tool to every session
  "autolearn.enabled": false,
} as const;

let ompSettingsReady: Promise<Settings> | null = null;

/**
 * OMP's write/edit path reads the process-global `settings` proxy (e.g.
 * auto-generated file guard). Session-local Settings.isolated() alone is not
 * enough — existing-file writes then throw "Settings not initialized".
 * Initialized once per process, with the first session's cwd.
 */
async function ensureOmpSettings(cwd: string): Promise<Settings> {
  if (!ompSettingsReady) {
    ompSettingsReady = Settings.init({
      cwd,
      inMemory: true,
      overrides: { ...PLAY_SETTINGS_OVERRIDES },
    }).catch((err) => {
      ompSettingsReady = null;
      throw err;
    });
  }
  return ompSettingsReady;
}

function playSettings(): Settings {
  return Settings.isolated({ ...PLAY_SETTINGS_OVERRIDES });
}

export type BuildSessionArgs = {
  cwd: string;
  sessionsDir: string;
  sessionManager: SessionManager;
  sandbox: Sandbox;
  factoryOpts?: OmpFactoryOptions;
  systemPrompt: string;
  contextFiles: SessionCreateOptions["contextFiles"];
  seedMessages?: SessionCreateOptions["seedMessages"];
  toolNames?: string[];
  /** Tool schemas offered for the session's life; defaults to `toolNames`. */
  offeredToolNames?: string[];
  searchFullModel?: string;
  searchFullReasoning?: string;
  /** Set by buildSession; adaptOmpSession flips it around hidden prompts. */
  localPrefillGate?: LocalPrefillGate;
  /** Set by buildSession; adaptOmpSession narrows it around scoped prompts. */
  toolScope?: ToolScope;
  /** Set by buildSession; how the adapter opens its illustration lookup session. */
  openSession?: (args: BuildSessionArgs) => Promise<AgentSession>;
};

async function buildSession(args: BuildSessionArgs): Promise<AgentSession> {
  const customTools = buildCustomTools(args.sandbox, {
    searchFullModel: args.searchFullModel,
    searchFullReasoning: args.searchFullReasoning,
  });
  const localPrefillGate: LocalPrefillGate = { hidden: false };
  const playToolNames = args.toolNames ?? [...PLAY_TOOL_NAMES];
  const offeredToolNames = [
    ...new Set([...(args.offeredToolNames ?? []), ...playToolNames]),
  ];
  const offered = new Set(offeredToolNames);
  const toolScope: ToolScope = { allowed: new Set(playToolNames) };
  const thinkingLevel = resolvePlayThinkingLevel(
    args.factoryOpts?.thinkingLevel,
  );
  const localShaping: LocalModelShaping = { thinkingLevel };
  const extensions = [
    // the pass's own tools first: a tool it may not call is refused outright
    createToolScopeExtension(toolScope),
    createSandboxJailExtension(args.sandbox),
    createLocalThinkingPrefillExtension(
      args.factoryOpts?.localThinkingOpener ?? "",
      localPrefillGate,
      localShaping,
    ),
    createOutputCapExtension(args.factoryOpts?.maxTokens ?? (() => undefined)),
  ];

  // Global singleton for stock tools; session still gets an isolated copy.
  await ensureOmpSettings(args.cwd);

  const agentContextFiles = args.contextFiles.filter(
    (pin) => !pin.generated,
  );

  const { session } = await createAgentSession({
    cwd: args.cwd,
    sessionManager: args.sessionManager,
    settings: playSettings(),
    systemPrompt: playProviderSystemPrompt(
      args.systemPrompt,
      args.contextFiles,
    ),
    // Always set — omit means OMP walks up from cwd to $HOME and
    // loads the user's coding AGENTS.md into the Game Master.
    contextFiles: agentContextFiles,
    skills: [],
    rules: [],
    promptTemplates: [],
    slashCommands: [],
    // The session's tools are fixed here, at creation, where OMP activates
    // custom tools under their own names. setActiveToolsByName would read
    // "search" as its legacy alias for the stock "grep" and drop our tool.
    toolNames: BUILTIN_FS_TOOL_NAMES.filter((name) => offered.has(name)),
    // MUST stay false: true drops customTools + caller extensions in 17.0.9.
    restrictToolNames: false,
    customTools: customTools.filter((tool) => offered.has(tool.name)),
    extensions,
    ...(args.factoryOpts?.connection
      ? {
          model: args.factoryOpts.connection.model,
          modelRegistry: args.factoryOpts.connection.modelRegistry,
        }
      : { modelPattern: args.factoryOpts?.model }),
    thinkingLevel,
    enableLsp: false,
    enableMCP: false,
    enableIrc: false,
    autoApprove: true,
    disableExtensionDiscovery: true,
  });

  await fitLiveModel(session, thinkingLevel, localShaping);

  if (args.seedMessages && args.seedMessages.length > 0) {
    // Inject history only. session.prompt({ synthetic: true }) still starts a
    // live model turn — unusable for a 40k-token rebuild-compaction tail.
    injectSeedMessages(session, args.seedMessages);
  }

  return adaptOmpSession(session, args.cwd, {
    ...args,
    offeredToolNames,
    localPrefillGate,
    toolScope,
    openSession: buildSession,
  });
}
