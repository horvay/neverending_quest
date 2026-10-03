# OMP session branch / “go to a message”

Primary sources: `@oh-my-pi/pi-coding-agent` 17.0.9 (`src/session/agent-session.ts`, `session-manager.ts`, `extensibility/shared-events.ts`, `tools/checkpoint.ts`).  
Does **not** pick how NQ Continue uses this. Related: [Rewind after history](../../.scratch/nq-play-authoring/issues/06-rewind-after-history.md), [Campaign git history](campaign-git-history.md).

## Yes — the session can rewind to an entry

`createAgentSession` returns an `AgentSession` that already has:

| API | What it does |
| --- | --- |
| `session.branch(entryId)` | Branch from a **user** message entry. New session file = path from root to that entry’s **parent**. In-memory messages replaced with that prefix (`agent.replaceMessages`). |
| `session.sessionManager.createBranchedSession(leafId)` | Same tree cut, but `leafId` can be **any** entry (including assistant). New jsonl under `.nq/sessions/`. |
| `session.sessionManager.pathTo` / `getBranch` / `getEntry` / `tree` | Walk the entry tree. |
| `session.fork()` | Copy the **current** leaf session to a new file. Does **not** rewind. |
| `session.switchSession(path)` | Load another session file. |

`branch` is the TUI `/branch` / tree-picker path. It **throws** unless `entry.type === "message"` and `message.role === "user"`. It then calls `createBranchedSession(selectedEntry.parentId)` — i.e. conversation ends **before** that user line (after the previous assistant).

Hook `session_before_branch` can `cancel` or `skipConversationRestore` (documented for a handler that restores files itself).

## Not this

OMP **`checkpoint` / `rewind` tools** are a different feature: in-turn workspace checkpoint + message-count restore. Settings: `checkpoint.enabled`. Not “jump to transcript row N.”

## Gaps for NQ Continue

- NQ **transcript rows** (`ts` + `role` + `text`) are **not** OMP `entryId`s. Need a map (e.g. store `entryId` on the GM row, or match user/assistant pairs).
- After **rebuild-compaction** NQ **replaces** the play session. Old ids are gone. Pre-compact Continue cannot `branch`.
- `branch` / `createBranchedSession` only change **`.nq/sessions/` conversation**. They do **not** restore Campaign markdown. Disk rewind stays isomorphic-git.
- NQ’s wrapper (`src/agent/omp/factory.ts`) does not expose `branch` today.

## Implication (fact, not a pick)

Continue can be: git-checkout the Campaign tree **and** `createBranchedSession` (or `branch` on the *next* user entry) so the live agent is already at that prefix — instead of dispose + `createAgentSession` + re-prime. After compact, only git + a new session + transcript tail remain.
