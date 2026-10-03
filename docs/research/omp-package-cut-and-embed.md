# OMP package cut and embed

Research note for ticket [OMP package cut and embed](../../.scratch/neverending-quest/issues/16-omp-package-cut-and-embed.md).  
Primary sources: installed `@oh-my-pi/*@17.0.9` under  
`/home/horvay/.cache/.bun/install/global/node_modules/@oh-my-pi/`  
(READMEs, `dist/types`, `src`, and `examples/sdk`). Inspected 2026-08-06.

## Summary (hybrid Play Loop embed)

| Topic | Recommendation | Source anchor |
| --- | --- | --- |
| **Dependency cut** | **Direct dep: `@oh-my-pi/pi-coding-agent@17.0.9` only** (pin exact). Transitive: `pi-ai`, `pi-agent-core`, `snapcompact`, `pi-utils`, `pi-wire`, `pi-catalog`, `pi-natives`, `hashline`, … Do **not** direct-depend on `pi-tui`, `pi-mnemopi`, or bare `snapcompact` for v1. | `pi-coding-agent/package.json` deps; SDK entry |
| **Embed API** | `createAgentSession({ … })` → `AgentSession` (`prompt`, `subscribe`, `compact`, `setActiveToolsByName`) | `dist/types/sdk.d.ts`, `examples/sdk/*` |
| **Thin alternative** | `pi-ai` + `pi-agent-core` only — viable but NQ must rebuild tools, session JSONL, compaction orchestration, auth/model registry | `pi-agent-core/README.md`, `pi-ai/README.md` |
| **`cwd` = Campaign** | `createAgentSession({ cwd: campaignAbsPath })` + `SessionManager.create(campaignAbsPath, …)` / `inMemory(campaignAbsPath)` | `CreateAgentSessionOptions.cwd`, `SessionManager` statics |
| **Tool allowlist** | `toolNames: ["read","edit","write"]` **and** `restrictToolNames: true` (required; otherwise custom/MCP/extension tools widen the set). Also forces `enableMCP`/`enableLsp`/IRC off. | `sdk.ts` + `createTools` |
| **Path sandbox** | Built-ins resolve relative to `cwd` but **do not hard-confine** absolute/`~` paths. NQ must add a `tool_call` extension (or wrap tools) that rejects targets outside the Campaign root. | `path-utils.ts`, `write.ts`, plan-mode sandbox is only `local://` artifacts |
| **Session vs Campaign transcript** | OMP JSONL = agent journal (tools, multi-round, compaction). Campaign `transcript` file = player-facing prose SoT. Keep both: OMP session under Campaign-private dir (or in-memory + export); dual-write final assistant text to Campaign transcript. | `SessionManager` class doc; product locks |
| **Compaction** | Use coding-agent auto-compact (`settings` `compaction.*`; default strategy `snapcompact`). Hooks: `session_before_compact` / `session.compacting` / `session_compact` / `auto_compaction_*`. Promote memory to Campaign files **before** compact (map decision from ticket 03). | `settings-schema.d.ts`, extension events |
| **Prose-only UI** | `session.subscribe`: stream `message_update` + `assistantMessageEvent.type === "text_delta"`; ignore/hide `tool_execution_*`. Multi tool rounds already inside one `prompt()` until `agent_end`. | `pi-agent-core/README.md` event flow; `examples/sdk/01-minimal.ts` |
| **Memory backends** | Leave `memory.backend = "off"` (default). No direct `pi-mnemopi` / Hindsight for v1 — Campaign files are durable memory. | coding-agent README; settings default `"off"` |
| **NQ-owned surface** | Do **not** ship `omp` interactive TUI as player UI. Optional later: depend on `pi-tui` for NQ’s own TUI widgets only. | product lock; `pi-tui` is a coding-agent dep |

---

## 1. Package map at 17.0.9

All inspected packages report **version `17.0.9`** and monorepo lockstep deps on each other.

| Package | Role | NQ relationship |
| --- | --- | --- |
| `@oh-my-pi/pi-ai` | Unified LLM stream/complete, models, providers (incl. xAI, OpenAI-compat, Ollama, llama.cpp, …), tool schemas (`z`), context types | **Transitive** via coding-agent / agent-core. Use `getModel` / registry from coding-agent SDK helpers. |
| `@oh-my-pi/pi-agent-core` | `Agent`, `agentLoop`, tool execution, `AgentEvent` stream, compaction primitives (`@oh-my-pi/pi-agent-core/compaction`) | **Transitive**. Direct only if choosing thin stack. |
| `@oh-my-pi/pi-coding-agent` | `createAgentSession`, `AgentSession`, built-in `read`/`edit`/`write`/…, `SessionManager`, settings, extensions/hooks, auto-compact | **Recommended direct dependency** |
| `@oh-my-pi/snapcompact` | Bitmap-frame context compression (vision models) | **Transitive** (agent-core + coding-agent). Selected via `compaction.strategy = "snapcompact"` (default). No direct import needed. |
| `@oh-my-pi/pi-mnemopi` | Local SQLite memory engine | **Do not direct-depend** for v1. Coding-agent can enable `memory.backend = "mnemopi"` later; product default lean is file memory only. |
| `@oh-my-pi/pi-tui` | Differential TUI toolkit used by `omp` interactive mode | **Do not direct-depend** for agent embed. NQ owns Play Loop TUI/CLI separately; may adopt `pi-tui` later as a pure UI library. |
| Other (`pi-utils`, `pi-wire`, `pi-catalog`, `pi-natives`, `hashline`, …) | Support | Transitive only |

**Install shape (conceptual):**

```json
{
  "dependencies": {
    "@oh-my-pi/pi-coding-agent": "17.0.9"
  }
}
```

Pin **exact** `17.0.9` (or a reviewed later patch). Coding-agent’s `package.json` already pins sibling `@oh-my-pi/*` to the same version.

---

## 2. Two embed stacks compared

### 2.1 Recommended: `createAgentSession` (coding-agent)

**Why it fits hybrid Play Loop**

- NQ keeps ownership of player I/O and Turn orchestration; coding-agent supplies an **OMP-shaped agent** (multi tool rounds per `prompt()`, file tools, session journal, compaction).
- Built-in **read / edit / write** match the Campaign Sandbox tool set (product lock).
- First-class **`cwd`**, **`toolNames` + `restrictToolNames`**, **`sessionManager`**, **`systemPrompt`**, extension/hook points, and event subscription for a prose-only surface.
- Model/auth discovery already knows xAI and OpenAI-compatible locals (Bonsai/llama-server path from tickets 01–02).

**Cost / weight**

- Heavy dependency tree (Puppeteer, search scrapers, MCP/LSP stacks, OTEL, etc. as *package* deps even when disabled at runtime).
- `restrictToolNames: true` is essential to strip MCP/LSP/IRC/image-gen/web_search and to stop custom/extension tools from attaching.
- Still need NQ path confinement (see §4).

**Minimal embed sketch** (from SDK types + examples):

```typescript
import { getModel } from "@oh-my-pi/pi-ai";
import {
  createAgentSession,
  discoverAuthStorage,
  discoverModels,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";

const campaignDir = "/abs/path/to/Campaign";
const authStorage = await discoverAuthStorage(/* optional NQ agentDir */);
const modelRegistry = await discoverModels(authStorage);
const settings = await Settings.isolated({
  "memory.backend": "off",
  "compaction.enabled": true,
  // optional: "compaction.strategy": "context-full" | "snapcompact" | …
});

const { session } = await createAgentSession({
  cwd: campaignDir,
  model: getModel("xai", "/* grok id from registry */"),
  authStorage,
  modelRegistry,
  settings,
  systemPrompt: [/* GM voice + Campaign seed instructions */],
  toolNames: ["read", "edit", "write"],
  restrictToolNames: true,
  // Prefer one of:
  sessionManager: SessionManager.inMemory(campaignDir),
  // sessionManager: SessionManager.create(campaignDir, path.join(campaignDir, ".nq", "sessions")),
  skills: [],
  contextFiles: [/* optional pin files as { path, content } */],
  disableExtensionDiscovery: true,
  extensions: [/* optional path-sandbox + promote-before-compact hooks */],
  hasUI: false,
  autoApprove: true, // Play Loop is non-interactive for tool gates
});

const unsub = session.subscribe((event) => {
  if (event.type === "message_update"
      && event.assistantMessageEvent?.type === "text_delta") {
    // stream player-visible prose only
    onProseDelta(event.assistantMessageEvent.delta);
  }
  if (event.type === "agent_end") {
    // finalize Turn; dual-write prose to Campaign transcript
  }
  // intentionally no UI for tool_execution_* 
});

await session.prompt(playerMessage);
// multi tool rounds already completed inside prompt()
```

Citations:

- Options: `pi-coding-agent/dist/types/sdk.d.ts` (`CreateAgentSessionOptions`: `cwd`, `toolNames`, `restrictToolNames`, `sessionManager`, `systemPrompt`, `enableMCP`, …).
- Examples: `examples/sdk/README.md` (read-only `toolNames` sample; full-control pattern), `01-minimal.ts`, `03-custom-prompt.ts`, `06-hooks.ts`, `11-sessions.ts`.
- `restrictToolNames` behavior: `pi-coding-agent/src/sdk.ts` (disables MCP/LSP/IRC, skips extension-registered tools and `options.customTools`).

### 2.2 Thin stack: `pi-ai` + `pi-agent-core`

**What you get**

- `stream` / `complete` / `getModel` (`pi-ai/README.md`).
- `new Agent({ initialState, convertToLlm, transformContext })`, `agent.prompt`, `agent.subscribe`, tool loop with the same event sequence (`pi-agent-core/README.md`).
- Compaction building blocks via `@oh-my-pi/pi-agent-core/compaction`.

**What NQ must rebuild**

- `read` / `edit` / `write` tools (hashline edit semantics live in coding-agent + `@oh-my-pi/hashline`).
- Session JSONL persistence, resume, branch (`SessionManager`).
- Auto-compact orchestration, settings, model registry/auth storage, system-prompt assembly.
- Approval, path policy, mid-turn overflow handling.

**When to choose thin**

- Hard requirement to avoid coding-agent’s install weight **and** willingness to own file-tool + session code.
- Otherwise **not** recommended for v1: reimplements the OMP-shaped agent the product explicitly wants to embed.

### 2.3 Tradeoff table

| Criterion | coding-agent `createAgentSession` | pi-ai + agent-core |
| --- | --- | --- |
| Time-to-correct hybrid loop | Short | Long |
| File tools quality (edit/hashline) | Built-in | Rewrite |
| Tool allowlist | `toolNames` + `restrictToolNames` | Manual `setTools` |
| Session resume / tree | `SessionManager` | Custom |
| Compaction | Settings + hooks + snapcompact | Manual wiring |
| Install weight | High | Lower |
| API surface churn | Higher (large package) | Lower core, more NQ code |
| Match “OMP-shaped agent” lock | Direct | DIY shape |

**Decision:** embed **coding-agent**; treat thin stack as escape hatch only.

---

## 3. `cwd` = Campaign folder

- `CreateAgentSessionOptions.cwd` — “Working directory for project-local discovery. Default: `getProjectDir()`” (`sdk.d.ts`).
- Tools receive `ToolSession.cwd`; relative paths in `read`/`edit`/`write` resolve against it.
- `SessionManager.create(cwd, sessionDir?)` stores `cwd` in the session header; `moveTo(newCwd)` exists if Campaign is relocated (`session-manager.d.ts`).
- `SessionManager.inMemory(cwd?)` keeps the same cwd semantics without a JSONL file.

**NQ practice**

1. Resolve Campaign path to an absolute directory before session create.
2. Pass that path as **both** `cwd` and `SessionManager` cwd.
3. Put GM seed / instructions into `systemPrompt` and/or explicit `contextFiles` (do not rely on accidental `AGENTS.md` discovery from a parent repo unless desired).
4. Prefer a dedicated `agentDir` (NQ config home) separate from the Campaign folder so global omp user config does not bleed into play — pass `agentDir` on `createAgentSession` / `Settings.init`.

---

## 4. Allowlist only `read` / `edit` / `write`

### 4.1 Name allowlist (API)

Built-in names include many tools (`BUILTIN_TOOL_NAMES` in `tools/builtin-names.ts`):  
`read`, `bash`, `edit`, `ast_grep`, `ast_edit`, `ask`, `debug`, `eval`, `github`, `glob`, `grep`, `lsp`, `browser`, `task`, `hub`, `todo`, `web_search`, `write`, memory tools, …

For Play:

```typescript
toolNames: ["read", "edit", "write"],
restrictToolNames: true,
```

| Flag | Effect (from `sdk.ts` / `createTools`) |
| --- | --- |
| `toolNames` only | Filters built-ins toward the list, but **without** restrict, custom tools, extension tools, and several auto-includes can still attach; MCP remains eligible. |
| `restrictToolNames: true` | Active set is **exactly** the supplied built-in names; MCP off; LSP off; IRC off; `customTools` / extension tools dropped; no image-gen / web_search injection. |

SDK README still shows the older “read-only tools” pattern with `toolNames` alone (`examples/sdk/README.md`); for NQ’s hard “no bash/web” lock, **always pair with `restrictToolNames: true`**.

Runtime tightening: `AgentSession.setActiveToolsByName(toolNames)` (`agent-session.d.ts`) if a mode needs a temporary subset.

### 4.2 Path allowlist (NQ must add)

Primary sources show:

- Relative paths resolve via session `cwd`.
- Absolute paths and `~` expansion are supported by path utilities (`path-utils.ts`).
- Plan-mode “sandbox” only protects the working tree vs `local://` artifacts — **not** a general Campaign jail (`plan-mode-guard.ts`).

Therefore **name allowlisting ≠ Campaign Sandbox**. NQ should register an extension:

```typescript
// pattern from examples/sdk/06-hooks.ts
api.on("tool_call", async (event) => {
  // resolve event.toolName + event.input paths; if outside campaignRoot →
  // return { block: true, reason: "…" }
});
```

Also block exotic `read`/`write` targets NQ does not want (`xd://`, `ssh://`, `mcp://`, `agent://`, URL fetches on `read` if any) unless explicitly required later.

Optional belt-and-suspenders: wrap `BUILTIN_TOOLS.read|edit|write` factories with path checks instead of/in addition to hooks.

---

## 5. Session persistence vs Campaign transcript

### 5.1 What OMP session is

`SessionManager` (`session-manager.d.ts`):

> Stores and navigates an **append-only conversation journal**. A session is a **JSONL** file: one header line followed by entries. Entries form a tree by `(id, parentId)` …

Includes user/assistant/tool messages, model changes, **compaction** entries, custom extension messages.  
Durability: software-crash safe append; not fsync/power-loss safe.

Factories:

| API | Use |
| --- | --- |
| `SessionManager.inMemory(cwd?)` | No file; good for tests / if NQ fully owns durability |
| `SessionManager.create(cwd, sessionDir?)` | New JSONL under default or custom dir |
| `SessionManager.open(path)` | Resume |
| `SessionManager.continueRecent(cwd, sessionDir?)` | Last session for cwd |
| `SessionManager.list(cwd, sessionDir?)` | Picker |

`createAgentSession` default is a manager under the configured agentDir sessions root when `sessionManager` omitted (`sdk.d.ts`).

### 5.2 What Campaign transcript is (product)

Player-facing story log and part of **Campaign files as source of truth**. It should not require tool-call JSON noise.

### 5.3 Recommended dual-store policy

| Store | Contents | Consumer |
| --- | --- | --- |
| **OMP session JSONL** (e.g. `Campaign/.nq/sessions/*.jsonl` or in-memory) | Full agent context: tool rounds, assistant raw messages, compaction summaries | Resume mid-Campaign agent brain; debugging |
| **Campaign transcript file** (schema from ticket 15) | Player + final GM **prose** turns only | Player UX, export, long-horizon human-readable log |
| **Other Campaign files** | sheet, dossiers, episodic | Model via `read`/`edit`/`write`; durable memory |

**Rules of thumb**

1. **Campaign files win** on conflict with anything only in the OMP journal.
2. On each Turn’s `agent_end`, append the final assistant **text** (concatenated text parts; strip tool-only assistants) to the Campaign transcript.
3. Before auto-compact, ensure dossier/sheet/episodic promotions already hit disk (hooks `session_before_compact` / `auto_compaction_start`) — aligns with research 03 “promote before eviction”.
4. Do **not** treat OMP session JSONL as the player-visible transcript.
5. Resume play: open Campaign folder → restore OMP session if present **and** re-prime from Campaign files via system prompt / context files (files remain SoT if journal is lost).

Open detail left on the map (“OMP session storage vs Campaign transcript dual-writing”) is refined here to: **yes dual-write; JSONL private; transcript prose-public**.

---

## 6. Compaction hooks

Settings (`settings-schema.d.ts`):

- `compaction.enabled` default **true**
- `compaction.midTurnEnabled` default **true**
- `compaction.strategy` default **`"snapcompact"`**  
  values: `"context-full" | "handoff" | "shake" | "snapcompact" | "off"`

Extension / session events (`shared-events.d.ts`, extension `on(…)` in `extensions/types.d.ts`):

| Event | Role for NQ |
| --- | --- |
| `session_before_compact` | Cancel/customize; inspect `preparation`; **flush promotions to Campaign files** |
| `session.compacting` | Tweak summarization messages |
| `session_compact` | After compact entry appended |
| `auto_compaction_start` / `auto_compaction_end` | UI status (operator/debug; not player prose) |

Manual: `session.compact(instructions?, options?)` (`agent-session.d.ts`).

`snapcompact` arrives transitively; NQ needs no direct import unless customizing bitmap compaction. If the chosen GM model is **non-vision**, prefer `context-full` or `handoff` over default `snapcompact` (settings override via `Settings.isolated` / agentDir config).

Agent-core also exposes low-level compaction utilities if NQ ever drops to the thin stack (`pi-agent-core/compaction`).

---

## 7. Event subscription for prose-only UI

Core sequence (`pi-agent-core/README.md`):

```
prompt(user)
  agent_start → turn_start → message_* (user)
  → message_* (assistant stream) → [tool_execution_* → toolResult → turn_end → turn_start → …]
  → agent_end
```

Coding-agent `AgentSession.subscribe` listens to `AgentSessionEvent` = core `AgentEvent` plus auto-compact/retry/etc. (`agent-session.d.ts`).

**Player surface**

| Event | Player UI |
| --- | --- |
| `message_update` + `assistantMessageEvent.type === "text_delta"` | Stream prose |
| `message_end` (assistant, no pending tools / after final turn) | Seal Turn bubble |
| `tool_execution_start` / `_update` / `_end` | **Hidden** (optional debug log) |
| `agent_end` | Turn complete → transcript append, input unlock |
| `auto_compaction_*` | Hidden or subtle status |

Multi tool rounds per player Turn are **already** inside one `session.prompt()` — Play Loop does not need to re-drive the tool loop.

Thinking/reasoning deltas (if enabled) should stay off the player stream unless product opens a debug mode.

---

## 8. Optional packages: depend or not

| Package | Depend directly? | Notes |
| --- | --- | --- |
| `pi-coding-agent` | **Yes** | Embed API |
| `pi-ai` | No (transitive) | May import types/`getModel` from it; still installed under coding-agent |
| `pi-agent-core` | No (transitive) | Same |
| `snapcompact` | No | Via compaction strategy |
| `pi-mnemopi` | **No** for v1 | `memory.backend` default `off`; map already leans file memory |
| `pi-tui` | **No** for agent embed | NQ-owned TUI; optional later UI dep |
| Full interactive `omp` binary UX | **No** | Out of scope / product lock |

---

## 9. Version / API stability notes (17.0.9)

1. **Lockstep versioning** — `@oh-my-pi/*` packages at 17.0.9 depend on each other at 17.0.9. Do not mix versions.
2. **Bun engine** — packages declare `"bun": ">=1.3.14"`. NQ runtime should assume Bun (or verified Node compatibility — not claimed by these package.json engines).
3. **Public embed surface** — `createAgentSession`, `SessionManager`, `Settings`, `discoverAuthStorage` / `discoverModels`, tool name exports are the supported SDK path (`examples/sdk`, `dist/types/sdk.d.ts`). Deep imports of `src/**` internals may churn.
4. **`restrictToolNames`** — relatively sharp edge; required for true allowlists. Older README snippets omit it.
5. **Hooks → extensions** — examples note hooks are now `extensions: ExtensionFactory[]` (`06-hooks.ts`).
6. **Memory backends** — `memory.backend`: `off` \| `local` \| `hindsight` \| `mnemopi`; default **off**. Enabling mnemopi/hindsight is a product change, not required by embed.
7. **Session files are not fsync-durable** — acceptable for agent journal; Campaign critical writes should use normal file tools / NQ flushes.
8. **Heavy optional features** stay out of the restricted tool session but remain in the install graph (browser, scrapers, …). Accept or vendor/patch later if binary size matters.
9. **Changelog velocity** is high (`pi-coding-agent/CHANGELOG.md` is large). Pin version; upgrade deliberately with a smoke Play Turn.

---

## 10. Concrete recommendation for NQ

1. **Depend on** `@oh-my-pi/pi-coding-agent@17.0.9` (exact).
2. **Embed** via `createAgentSession` with:
   - `cwd` = absolute Campaign path  
   - `toolNames: ["read","edit","write"]` + **`restrictToolNames: true`**  
   - `memory.backend: "off"`  
   - `disableExtensionDiscovery: true` + small NQ extensions (path jail, promote-before-compact, optional transcript mirror)  
   - `sessionManager` = `SessionManager.create(campaign, campaign/.nq/sessions)` **or** in-memory + explicit export  
   - `hasUI: false`, `autoApprove: true`  
   - custom `systemPrompt` (GM) + explicit context pins as needed  
3. **UI**: NQ Play Loop subscribes for `text_delta` only; tools hidden.  
4. **Durability**: Campaign files SoT; OMP JSONL is agent journal; dual-write final prose to Campaign transcript.  
5. **Do not** direct-depend on `pi-tui` / `pi-mnemopi` / `snapcompact` for v1.  
6. **Thin stack** reserved if coding-agent weight becomes blocking — expect to reimplement tools + session.

Does **not** decide Campaign file schema (ticket 15) or full Play Loop SM (ticket 17).

---

## Sources

Installed tree: `/home/horvay/.cache/.bun/install/global/node_modules/@oh-my-pi/`

- `pi-coding-agent/package.json` (v17.0.9, dependency list, exports)
- `pi-coding-agent/README.md` (memory backends)
- `pi-coding-agent/dist/types/sdk.d.ts` (`CreateAgentSessionOptions`, `createAgentSession`)
- `pi-coding-agent/dist/types/session/session-manager.d.ts`
- `pi-coding-agent/dist/types/session/agent-session.d.ts` (`subscribe`, `prompt`, `compact`, events)
- `pi-coding-agent/dist/types/tools/builtin-names.d.ts` / `src/tools/builtin-names.ts`
- `pi-coding-agent/src/tools/index.ts` (`BUILTIN_TOOLS`, `createTools`, `restrictToolNames`)
- `pi-coding-agent/src/sdk.ts` (`restrictToolNames` → MCP/LSP/IRC/custom tools)
- `pi-coding-agent/dist/types/config/settings-schema.d.ts` (`compaction.*`, `memory.backend`)
- `pi-coding-agent/dist/types/extensibility/shared-events.d.ts` (compact events)
- `pi-coding-agent/examples/sdk/README.md`, `01-minimal.ts`, `03-custom-prompt.ts`, `06-hooks.ts`, `11-sessions.ts`
- `pi-agent-core/package.json`, `README.md` (Agent, events, tools, telemetry)
- `pi-agent-core/dist/types/index.d.ts`, `compaction.d.ts`
- `pi-ai/package.json`, `README.md` (providers, stream, tools)
- `snapcompact/package.json`
- `pi-mnemopi/package.json`
- `pi-tui/package.json`
