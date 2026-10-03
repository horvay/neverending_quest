/**
 * Adapts an OMP agent session to the Play Loop's `AgentSession`.
 *
 * Play prompts stream prose to the player; hidden prompts (Memory Hygiene)
 * run against a checkpoint and are rolled back out of the journal after.
 * A prompt may narrow the tools it can call within the offered schemas, or
 * swap the schemas outright. A local model's prose is filtered of thinking
 * leaks and answer labels before it reaches the player.
 *
 * prompt() flips state this session shares with its OMP extensions (the
 * thinking-prefill gate and the tool scope) for the prompt it runs. That is
 * correct only while prompts are serialized, which the Play Loop guarantees:
 * it never starts a prompt on a session before the last one has settled.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SessionManager,
  type AgentSession as OmpAgentSession,
} from "@oh-my-pi/pi-coding-agent";
import { isLlamaCppModel } from "../llama_cpp.ts";
import { ILLUSTRATION_READ_TOOLS } from "../../play/sandbox.ts";
import { ILLUSTRATION_LOOKER_SYSTEM } from "../../play/illustration.ts";
import { buildIllustrationLookerPins } from "../../play/context.ts";
import {
  createLocalProseFilter,
  stripLeadingLocalAnswerLabel,
  stripTrailingInternalNotes,
} from "../wire_shaping.ts";
import type {
  AgentPromptResult,
  AgentSession,
  AgentSessionEvent,
} from "../../play/types.ts";
import { extractAssistantText, mapOmpEvent } from "./events.ts";
import type { BuildSessionArgs } from "./factory.ts";
import {
  appendHiddenHistoryMarker,
  appendTranscriptSyncMarker,
  captureHiddenHistory,
  hasCleanHiddenHistoryMarker,
  restoreHiddenHistory,
} from "./journal.ts";

/** @internal Adapter seam exported for provider-history behavior tests. */
export function adaptOmpSession(
  session: OmpAgentSession,
  cwd: string,
  buildArgs: BuildSessionArgs,
): AgentSession {
  const openSession = buildArgs.openSession;
  if (!hasCleanHiddenHistoryMarker(session.sessionManager)) {
    appendHiddenHistoryMarker(session.sessionManager, "clean");
  }
  const handlers = new Set<(e: AgentSessionEvent) => void>();
  let lastAssistant = "";
  let aborted = false;
  const localProseFilter = isLlamaCppModel(buildArgs.factoryOpts?.model)
    ? createLocalProseFilter()
    : undefined;
  const unsub = session.subscribe((ev) => {
    const mapped = mapOmpEvent(ev);
    if (mapped?.type === "prose_delta") {
      const text = localProseFilter
        ? localProseFilter.push(mapped.text)
        : mapped.text;
      if (text) {
        lastAssistant += text;
        for (const h of handlers) h({ ...mapped, text });
      }
    } else if (mapped?.type === "prose_reset") {
      localProseFilter?.reset();
      for (const h of handlers) h(mapped);
    } else if (mapped) {
      if (mapped.type === "tool_call") {
        localProseFilter?.reset();
        for (const h of handlers) h({ type: "prose_reset" });
      }
      for (const h of handlers) h(mapped);
    }
    if (
      ev &&
      typeof ev === "object" &&
      "type" in ev &&
      (ev as { type: string }).type === "message_end"
    ) {
      const msg = (ev as { message?: { role?: string; content?: unknown } })
        .message;
      if (msg?.role === "assistant") {
        const text = extractAssistantText(msg);
        if (text) {
          const playerText = localProseFilter
            ? stripLeadingLocalAnswerLabel(text)
            : text;
          lastAssistant = stripTrailingInternalNotes(playerText);
        }
      }
    }
  });

  return {
    id: `omp:${cwd}`,
    async prompt(text, opts): Promise<AgentPromptResult> {
      lastAssistant = "";
      localProseFilter?.reset();
      aborted = false;
      const onAbort = () => {
        aborted = true;
        session.abort({ reason: "nq-interrupt" });
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      const hiddenHistory =
        opts?.hidden === true ? captureHiddenHistory(session) : undefined;
      // the gate and the scope are shared with this session's extensions and
      // set for this prompt only; the Play Loop never overlaps two prompts
      const prefillGate = buildArgs.localPrefillGate;
      if (prefillGate) {
        prefillGate.hidden = opts?.hidden === true;
        prefillGate.opener = opts?.thinkingOpener;
      }
      // a pass scoped within the offered tools keeps the same schemas and is
      // enforced when a tool is called; anything else swaps the schemas, which
      // goes through OMP's aliasing and so cannot carry our `search` tool
      const toolScope = buildArgs.toolScope;
      const playScope = toolScope?.allowed;
      const offered = new Set(buildArgs.offeredToolNames ?? []);
      const swapTools =
        opts?.toolNames !== undefined &&
        (!toolScope || !opts.toolNames.every((name) => offered.has(name)));
      const priorToolNames = swapTools
        ? session.getEnabledToolNames()
        : undefined;
      let toolsChanged = false;
      try {
        if (opts?.signal?.aborted) {
          return { prose: "", aborted: true, error: "aborted" };
        }
        if (toolScope && opts?.toolNames) {
          toolScope.allowed = new Set(opts.toolNames);
        }
        if (swapTools && opts?.toolNames) {
          if (typeof session.setActiveToolsByName !== "function") {
            throw new Error("OMP session cannot apply prompt-scoped tools");
          }
          await session.setActiveToolsByName([...opts.toolNames]);
          toolsChanged = true;
        }
        const ok = await session.prompt(text, {
          expandPromptTemplates: false,
          synthetic: opts?.hidden === true,
          skipCompactionCheck: opts?.hidden === true,
        });
        if (aborted || opts?.signal?.aborted) {
          return { prose: "", aborted: true, error: "aborted" };
        }
        if (opts?.hidden === true && session.agent.state.error) {
          return { prose: "", error: String(session.agent.state.error) };
        }
        const playerText = localProseFilter
          ? stripLeadingLocalAnswerLabel(lastAssistant)
          : lastAssistant;
        const prose = stripTrailingInternalNotes(playerText);
        if (!ok && prose.trim().length === 0) {
          return { prose: "", error: "agent ended without assistant prose" };
        }
        return { prose };
      } catch (err) {
        if (aborted || opts?.signal?.aborted) {
          return { prose: "", aborted: true, error: "aborted" };
        }
        return {
          prose: "",
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (prefillGate) {
          prefillGate.hidden = false;
          prefillGate.opener = undefined;
        }
        if (toolScope && playScope) toolScope.allowed = playScope;
        try {
          if (hiddenHistory) {
            await restoreHiddenHistory(session, hiddenHistory);
          }
        } finally {
          if (
            toolsChanged &&
            priorToolNames &&
            typeof session.setActiveToolsByName === "function"
          ) {
            await session.setActiveToolsByName(priorToolNames);
          }
          opts?.signal?.removeEventListener("abort", onAbort);
        }
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    abort() {
      aborted = true;
      session.abort({ reason: "nq-interrupt" });
    },
    async end() {
      unsub();
      await session.dispose();
    },
    contextTokens() {
      try {
        const n = session.getContextUsage()?.tokens;
        if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
      } catch {
        // fall through — Play Loop estimates
      }
      return undefined;
    },
    markTranscriptSync(digest) {
      appendTranscriptSyncMarker(session.sessionManager, digest);
    },
    async runEphemeralTurn(opts): Promise<AgentPromptResult> {
      try {
        const { replyText } = await session.runEphemeralTurn({
          promptText: opts.promptText,
          signal: opts.signal,
        });
        return { prose: replyText };
      } catch (err) {
        if (opts.signal?.aborted) {
          return { prose: "", aborted: true, error: "aborted" };
        }
        return {
          prose: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    runLookupTurn: openSession
      ? (opts) => runLookupTurn(openSession, cwd, buildArgs, opts)
      : undefined,
  };
}

/**
 * Illustration lookup in a throwaway second session over the same Campaign:
 * read-only tools, its own temp journal, so the live session never sees it.
 */
async function runLookupTurn(
  openSession: (args: BuildSessionArgs) => Promise<AgentSession>,
  cwd: string,
  buildArgs: BuildSessionArgs,
  opts: Parameters<NonNullable<AgentSession["runLookupTurn"]>>[0],
): Promise<AgentPromptResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nq-illust-"));
  let lookup: AgentSession | undefined;
  try {
    lookup = await openSession({
      cwd,
      sessionsDir: dir,
      sessionManager: SessionManager.create(cwd, dir),
      sandbox: buildArgs.sandbox,
      factoryOpts: buildArgs.factoryOpts,
      systemPrompt: ILLUSTRATION_LOOKER_SYSTEM,
      contextFiles: await buildIllustrationLookerPins(cwd),
      toolNames: [...ILLUSTRATION_READ_TOOLS],
      searchFullModel: buildArgs.searchFullModel,
      searchFullReasoning: buildArgs.searchFullReasoning,
    });
    const unsub = opts.onEvent ? lookup.subscribe(opts.onEvent) : () => {};
    try {
      return await lookup.prompt(opts.promptText, {
        hidden: true,
        signal: opts.signal,
      });
    } finally {
      unsub();
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      return { prose: "", aborted: true, error: "aborted" };
    }
    return {
      prose: "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await lookup?.end().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
