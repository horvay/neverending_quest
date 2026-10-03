/**
 * The OMP journal under `.nq/sessions/`: the Game Master's private history.
 *
 * NQ keeps two custom markers in it. The hidden-history marker says whether
 * the journal's tip is clean play history or a hidden pass (Memory Hygiene)
 * still in flight; the transcript-sync marker records which player transcript
 * the journal matches. A journal resumes only when both line up.
 */
import {
  SessionManager,
  type AgentSession as OmpAgentSession,
} from "@oh-my-pi/pi-coding-agent";
import type { SessionCreateOptions } from "../../play/types.ts";

const HIDDEN_HISTORY_MARKER = "nq-hidden-history-isolation";
const TRANSCRIPT_SYNC_MARKER = "nq-transcript-sync";
const RESUME_CANDIDATES = 3;

/**
 * The newest journal of this Campaign that is clean and matches the player
 * transcript, opened; null when none does.
 */
export async function openResumableJournal(cont: {
  cwd: string;
  sessionsDir: string;
  transcriptDigest: string;
}): Promise<SessionManager | null> {
  // Not SessionManager.continueRecent: that follows OMP's per-terminal
  // breadcrumb, which after a restart in another terminal names an older
  // journal of this Campaign. A few newest are tried because a hygiene
  // restore can leave its clean branch sharing an mtime with the source.
  const list = await SessionManager.list(cont.cwd, cont.sessionsDir);
  for (const info of list.slice(0, RESUME_CANDIDATES)) {
    const candidate = await SessionManager.open(
      info.path,
      cont.sessionsDir,
      undefined,
      { suppressBreadcrumb: true },
    );
    if (
      hasCleanHiddenHistoryMarker(candidate) &&
      latestTranscriptSync(candidate) === cont.transcriptDigest
    ) {
      return candidate;
    }
    await candidate.close();
  }
  return null;
}

export function injectSeedMessages(
  session: OmpAgentSession,
  seedMessages: NonNullable<SessionCreateOptions["seedMessages"]>,
): void {
  // Stamp seeded replies with the model that will read them: OMP replays an
  // assistant message from another model through its cross-model path.
  const model = session.model as
    | { api: string; provider: string; id: string }
    | undefined;
  let ts = Date.now();
  for (const msg of seedMessages) {
    ts += 1;
    const injected = toOmpHistoryMessage(msg, ts, model);
    session.agent.appendMessage(injected);
    session.sessionManager.appendMessage(injected);
  }
}

function toOmpHistoryMessage(
  msg: { role: "user" | "assistant" | "system"; content: string },
  timestamp: number,
  model: { api: string; provider: string; id: string } | undefined,
) {
  if (msg.role === "assistant") {
    return {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: msg.content }],
      api: model?.api ?? "openai-completions",
      provider: model?.provider ?? "nq",
      model: model?.id ?? "nq-seed",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp,
    };
  }
  if (msg.role === "system") {
    return {
      role: "developer" as const,
      content: msg.content,
      attribution: "agent" as const,
      timestamp,
    };
  }
  return {
    role: "user" as const,
    content: msg.content,
    synthetic: true,
    timestamp,
  };
}

export function hasCleanHiddenHistoryMarker(
  sessionManager: SessionManager,
): boolean {
  for (const entry of sessionManager.getBranch().toReversed()) {
    if (entry.type !== "custom" || entry.customType !== HIDDEN_HISTORY_MARKER) {
      continue;
    }
    return (
      entry.data !== null &&
      typeof entry.data === "object" &&
      "state" in entry.data &&
      entry.data.state === "clean"
    );
  }
  return false;
}

function latestTranscriptSync(sessionManager: SessionManager): string | null {
  for (const entry of sessionManager.getBranch().toReversed()) {
    if (entry.type !== "custom" || entry.customType !== TRANSCRIPT_SYNC_MARKER) {
      continue;
    }
    return entry.data !== null &&
      typeof entry.data === "object" &&
      "digest" in entry.data &&
      typeof entry.data.digest === "string"
      ? entry.data.digest
      : null;
  }
  return null;
}

export function appendTranscriptSyncMarker(
  sessionManager: SessionManager,
  digest: string,
): void {
  sessionManager.appendCustomEntry(TRANSCRIPT_SYNC_MARKER, { digest });
}

export function appendHiddenHistoryMarker(
  sessionManager: SessionManager,
  state: "clean" | "dirty",
): void {
  sessionManager.appendCustomEntry(HIDDEN_HISTORY_MARKER, { state });
}

/** Where a hidden pass started, so it can be rolled back out of history. */
export type HiddenHistoryCheckpoint = {
  manager: SessionManager;
  leafId: string | null;
  messages: OmpAgentSession["agent"]["state"]["messages"];
};

export function captureHiddenHistory(
  session: OmpAgentSession,
): HiddenHistoryCheckpoint {
  const checkpoint = {
    manager: session.sessionManager.cloneCurrentSession(),
    leafId: session.sessionManager.getLeafId(),
    messages: [...session.agent.state.messages],
  };
  appendHiddenHistoryMarker(session.sessionManager, "dirty");
  return checkpoint;
}

/**
 * Puts the session back on a clean branch from before the hidden pass: a new
 * journal file branched at the checkpoint when OMP can write one, otherwise
 * the same journal re-pointed at the checkpoint leaf.
 */
export async function restoreHiddenHistory(
  session: OmpAgentSession,
  checkpoint: HiddenHistoryCheckpoint,
): Promise<void> {
  try {
    const cleanSessionFile =
      checkpoint.leafId === null
        ? await checkpoint.manager.newSession({
            parentSession: session.sessionManager.getSessionFile(),
          })
        : checkpoint.manager.createBranchedSession(checkpoint.leafId);
    if (cleanSessionFile) {
      const switched = await session.switchSession(cleanSessionFile);
      if (!switched) {
        throw new Error("OMP cancelled hidden history restoration");
      }
      return;
    }

    if (checkpoint.leafId === null) {
      session.sessionManager.resetLeaf();
    } else {
      session.sessionManager.branch(checkpoint.leafId);
    }
    session.agent.replaceMessages(checkpoint.messages);
  } finally {
    await checkpoint.manager.close();
  }
}
