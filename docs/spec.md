# Neverending Quest — Build-ready spec (v1 POC)

Product + architecture contract for implementation. Domain vocabulary: root [`CONTEXT.md`](../CONTEXT.md). Hard architectural decisions: [`docs/adr/`](adr/).

This document does **not** reopen locked product or architecture choices. Implementers may still decide items listed under [Implementer latitude](#implementer-latitude) and [Open questions](#open-questions).

---

## 1. Goals

- Long-running single-player AI **Game Master** play against a durable **Campaign** folder.
- Fight context rot with **file-backed hybrid memory** (Player Sheet, World-Building, Dossiers, Story Beats, Quest Log) plus NQ-owned **Context Assembly** and **rebuild-compaction**.
- NQ owns the **Play Loop** and **Player Surfaces** (`nq play` OpenTUI, `nq serve` localhost Preact page): **Home** then one Campaign; inference and multi-step file tools come from an embedded OMP-shaped agent (`cwd` = Campaign).
- Player sees **story prose** as the committed game text. During Turning, surfaces show **live Scratch** (thinking + tool name/path/roll purpose and result/wrote). After SUCCESS that block collapses onto the GM row. The web Status leaf also shows a newest-first **Roll Log** of completed Campaign rolls with Turn, die, result, and stated purpose. Hygiene and rebuild-compaction stream live Scratch on the web story leaf, then retain it as one collapsed, surface-ephemeral maintenance block. No harness chrome as the game client. The web surface may also **Inspect** Campaign memory (Idle Save). Surfaces may **edit** the transcript, expand **Scratch**, fire hygiene/compact by hand, and **Rewind** the Campaign folder ([ADR-0006](adr/0006-play-authoring.md)).
- Handoff is this spec + ADRs so implementation can start without re-grilling core shape.

## 2. Non-goals (v1 POC)

- Hosted / LAN / mobile clients (localhost web **is** in scope — [ADR-0004](adr/0004-dual-player-surfaces.md))
- Multiplayer or shared-world servers
- Hard rules engine or action validation that blocks player freedom
- Vector-only free-text RAG as primary memory
- Full interactive `omp` as the player-facing client
- Bash/web/LSP tools during play
- Structured Side-channel-beside-chat as the memory path
- Regenerating a GM reply from scratch; automatic undo of a torn FAIL Turn (Delete Rewinds the `fail` commit); a second git timeline / undo-Continue
- Polished product packaging/distribution
- Full content-bible authoring beyond Seed Pack materialization
- mnemopi / Hindsight beside file memory

See also map **Out of scope** and ADR-0002 considered options.

---

## 3. System shape

**Hybrid architecture** ([ADR-0002](adr/0002-hybrid-omp-agent-campaign-folder.md)):

| Layer                                                                                                                                                                                                                               | Owner                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| CLI, Player Surfaces, Play Kernel, Effect `PlaySession` adapter, Play Loop, transcript dual-write, sandbox guard, Context prime, Memory Hygiene triggers, rebuild-compaction, Campaign git history (isomorphic-git), play authoring | **NQ**                                                                        |
| Model registry, streaming, tool loop, session JSONL, `createAgentSession`                                                                                                                                                           | **Embedded OMP** (`@oh-my-pi/pi-coding-agent@17.0.9`)                         |
| Standing facts + chronicle on disk                                                                                                                                                                                                  | **Campaign folder** ([ADR-0003](adr/0003-campaign-folder-memory-contract.md)) |

**Source layout** ([ADR-0010](adr/0010-layered-source-and-workspace-packages.md)): `src/campaign` → `src/play` (game core: Play Loop, Kernel, Context Assembly, sandbox and Game Master tools) → `src/agent` (Game Masters behind the agent port) and `src/home` → `src/surfaces/{tui,web,hosted}` → `src/cli.ts`. Engines and the Local Inference Host are the workspace package `@nq/local-inference`; the sealed transport is `@nq/seal`. `bun run typecheck` rejects an import that points up the stack.

**Package cut:** direct dependency `@oh-my-pi/pi-coding-agent@17.0.9` only (pin exact). Use `createAgentSession` with:

- `cwd` = Campaign absolute path
- `SessionManager` under `.nq/sessions/`
- Register built-in `read` / `edit` / `write` plus NQ custom tools with `restrictToolNames: false`; pin the active play set to `read` / `roll` / `search` / `search_full`, then temporarily switch to the Hygiene set for hidden Hygiene prompts
- `memory.backend: "off"`
- OMP stock **compaction disabled** on the play path (NQ rebuild-compaction instead)

No direct deps on `pi-tui`, `pi-mnemopi`, or bare `snapcompact` for v1. Path jail is **not** built-in — NQ must reject tool targets outside the Campaign root (`tool_call` extension or wrapped tools). Campaign history is **isomorphic-git** (MIT, Bun `node:fs`) — not the `git` CLI, not LightningFS ([ADR-0006](adr/0006-play-authoring.md)).

**Inference:** user’s Grok account first via OMP model stack; local OpenAI-compatible (Bonsai / llama-server) as later profile. Capability constraints from research notes (bibliography) — not a NQ-owned Chat Completions port ([ADR-0001](adr/0001-provider-chat-completions-port.md) superseded for product shape).

**Rules philosophy:** no mechanical enforcement; player freedom absolute; declared powers become current truth immediately and Memory Hygiene records them on the **Player Sheet**.

---

## 4. Campaign folder contract

Binding tree and roles: **[ADR-0003](adr/0003-campaign-folder-memory-contract.md)**. Summary for implementers:

```
<campaign>/
  campaign.yaml
  seed.md
  player_sheet.md
  world-building.md
  dossiers/<slug>.md
  story-beats.md
  quest-log.md
  twists.md
  transcript.jsonl
  .nq/sessions/
  .nq/play_state.json
  .nq/scratch.jsonl
  illustrations/<id>.png
  .git/                 # local history; players do not run git
  .gitignore            # ignore .nq/sessions/ and illustrations/
```

| Path                     | Format / contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `campaign.yaml`          | `id` (uuid), `created_at`, `schema_version`, `name`. NQ-owned. No model profile fields. Tracked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `seed.md` | Campaign premise and rules in free markdown, included under `# The Scenario` after the global voice and optional personality. The Game Master does not write it (convention); the player may rewrite it from Inspect (World → Seed). Tracked. |
| `player_sheet.md`        | Required H2s: Description, Inventory, Powers, Notes. Durable PC baseline; recent successful dialogue may be newer until Hygiene catches it up. Whole file always pinned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `world-building.md`      | Free markdown. Factions/events/ecology/setting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dossiers/<slug>.md`     | Slug `[a-z0-9-]+` = durable id; never rename or delete. Required FM: `name`, `aliases`, `kind` (`person`\|`place`\|`other`); person FM keeps `regard`, `personality`, and `appearance`; non-person FM may keep `appearance`; merge stubs use `stub_of`. Body allows only optional `Inventory` (people), `Relationships`, `Abilities`, `Quirks`, and `Establishment` (places) H2s. New dossiers scaffold every applicable heading empty. Chronology, encounters, recent actions, and event history belong in Story Beats. Existing dossiers receive surgical `edit` operations; `write` only creates a new dossier. Merge → keeper + thin stub. |
| `story-beats.md`         | Hygiene-authored Ultra chronicle; v1 append-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `quest-log.md`           | Hygiene-authored open bullets; delete when done. |
| `twists.md`              | Hygiene-authored forward plan: 3–6 unspent one-line twists, each grounded in a live person, quest, or beat, each naming what would reveal it. Read-only during a Turn and never stated in prose; a twist is possibility, not canon, until play makes it happen. Landed twists are deleted and their outcome recorded in Story Beats. Whole file pinned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `transcript.jsonl`       | `{ts, role: player\|gm, text, illustration?, illustrationPrompt?}`. NQ appends; player Edit may change `text` only (`ts`/`role` stay). Optional `illustration` is the GM row `ts` when the player requested a picture; `illustrationPrompt` is the Anima prompt used to paint it ([ADR-0007](adr/0007-illustration.md)).                                                                                                                                                                                                                                                                                                                           |
| `illustrations/<id>.png` | Player-requested Illustration file. **Ignored.** Id = GM row `ts`. Not primed. Not Inspect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `.nq/play_state.json`    | NQ-only Turn, hygiene, and Luck Point state (see §7–8). Tracked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `.nq/scratch.jsonl`      | NQ-owned Scratch records (see Play authoring). Tracked. GM tools denied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `.nq/sessions/`          | OMP journal. **Ignored.** Campaign files win.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `.gitignore`             | Must ignore `.nq/sessions/` and `illustrations/`. Tracked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Fact destinations:** Memory Hygiene writes PC standing truth → sheet; recurring person/place standing facts → dossier; world facts → world-building; what happened → beats; open leads → quest-log. A play Turn leaves newly established durable facts in successful transcript rows; one-shot color remains transcript-only.

**Writing boundary:** Compact factual wording applies only to Memory Hygiene writes. Its instruction preserves names, numbers, negation, causality, and scope or time qualifiers. Event history belongs only in Story Beats, one compact factual beat per line. Dossiers hold current, durable subject facts, not scene summaries, recent actions, or one-off reactions; lasting traits and relationships need an explicit commitment, a lasting change, or recurring evidence. An event can update a standing fact without its story being copied into the dossier. Neither the ordinary GM prompt nor local reasoning receives memory-compression instructions.

**Sandbox path policy:** Play tools are `read` / `roll` / `search` / `search_full`. Hygiene temporarily receives `read` / `edit` / `write` / `search` / `search_full` / `archive`, then the session returns to the play set. Both modes deny writes to `transcript.jsonl`, `campaign.yaml`, `.nq/**`, and `illustrations/**`.

---

## 5. Play Loop

Two states: **Idle** / **Turning**. One OMP play session per Campaign process lifetime (`continueRecent` under `.nq/sessions/`). Memory writes are **live-through** (no automatic Turn rollback of a FAIL; FAIL still commits). Player **Rewind** is a separate Idle action ([ADR-0006](adr/0006-play-authoring.md)).

```text
Campaign open
  → require campaign.yaml
  → lazy-ensure skeleton files
  → ensure local git (init + commit if no .git)
  → Campaign Sandbox (path jail + tool allowlist)
  → assemble current Game Master voice, personality, Campaign seed, runtime contract, and memory pins
  → SessionManager.continueRecent(.nq/sessions) with that Context Assembly, or create
  → load/create .nq/play_state.json
  → Idle

Idle
  → accept player input **or** play-authoring requests only here
  → append transcript player row → Turning
  → start wall-clock Turn timer (default 180s)

Turning
  → hard-busy (no further input)
  → session.prompt(playerText)  // multi tool rounds; no tool-round cap
  → live-through file writes
  → events: turn_started, prose_delta, turn_ended (+ debug dump if -d)

SUCCESS ≔ agent_end ∧ non-empty final assistant text ∧ not aborted
  → append transcript gm row  (or **replace** last GM row on Continue-extend)
  → write persisted Scratch record (play prompt only; maintenance Scratch is surface-ephemeral)
  → success_turn_count += 1; persist play_state
  → still busy: hygiene / rebuild-compact path (§7–8)
  → one isomorphic-git commit (automatic hygiene/compact folded in)
  → Idle

STOPPED ≔ interrupt after the player has seen GM prose (the live draft since the last tool call)
  → that draft becomes the gm row; otherwise as SUCCESS
  → then replace the play session and re-prime (the aborted session holds a torn reply)
  → Continue finishes the row; `nq turn` still exits 130

FAIL ≔ interrupt with no visible prose | timeout | repetition | provider/agent hard fail | empty final prose
  → abort agent if running
  → keep live file writes; no gm transcript row
  → success_turn_count unchanged; no hygiene
  → one isomorphic-git commit (`fail`)
  → Idle
```

| Artifact                                                 | When written                        | On FAIL                            |
| -------------------------------------------------------- | ----------------------------------- | ---------------------------------- |
| Memory MD (sheet, dossiers, world, beats, quests, notes) | Each successful tool call           | **Kept**                           |
| transcript player row                                    | Input accept                        | **Kept**                           |
| transcript gm row                                        | SUCCESS only                        | **Not written**                    |
| OMP `.nq/sessions/*`                                     | Harness during run                  | Partial OK; **Campaign files win** |
| `.nq/play_state.json`                                    | Luck arm/use/recovery; SUCCESS; hygiene bookkeeping | Luck changes from resolved rolls stay spent or restored |
| `.nq/scratch.jsonl`                                      | After play SUCCESS                  | Unchanged on FAIL                  |

**Non-goals:** regenerate, shadow undo of a torn Turn, hard tool-round cap, async hygiene overlapping the next Turn.

### Play authoring (Idle)

Surfaces request. Play Kernel stays `submit` / `interrupt`. **Idle only** (disabled while Turning, hygiene, or compact). After Rewind / Edit / Delete / Inspect Save / Continue: **replace** the play session and **re-prime** — do not `continueRecent` a restored journal.

**Git (isomorphic-git, branch `main`, NQ-owned committer).** No `git` binary. Rewind = `writeRef` + `checkout({ force: true })`. Tip **moves**. No forward ref. History list = reachable commits only.

| Moment                                               | Commit                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `nq new` / Home New                                  | `init` + birth commit                                                                |
| First open, no `.git`                                | `init` + commit current tree                                                         |
| Opening message copied into an empty transcript      | yes                                                                                  |
| Successful Turn, after the SUCCESS→Idle busy window  | **one** commit (auto hygiene/compact included)                                       |
| FAIL (interrupt / timeout / empty / hard fail)       | **one** commit (`fail`)                                                              |
| Transcript Edit                                      | yes                                                                                  |
| Delete last finished Turn                            | rewind to the previous Turn snapshot (no extra commit)                               |
| Delete FAIL tail                                     | rewind the `fail` commit (no extra commit); legacy dirty tail still chops + `delete` |
| Inspect Save / create dossier / archive or unarchive | yes                                                                                  |
| Illustration stamp (PNG stays untracked)             | yes (`illustrate`)                                                                   |
| Manual Light / Heavy / Compact / Fresh success | yes                                                                                  |
| Open of an already-inited Campaign                   | no                                                                                   |
| Unchanged tree                                       | no                                                                                   |

**Track:** prescribed memory, `transcript.jsonl`, `.nq/scratch.jsonl`, `.nq/play_state.json`, `campaign.yaml`, `seed.md`, `.gitignore`. **Ignore:** `.nq/sessions/` and `illustrations/`.

**Edit.** Player and GM rows, including the opening. `text` only; `ts`/`role` stay. Writes `transcript.jsonl` only. Later rows stay. TUI `/edit N` is GM of Turn `N`; bare `/edit` is the last row; older player rows are book-only.

**Delete.** Last row or last player+GM pair only. Mid-log delete refused. A finished last Turn **rewinds** the Campaign tree (isomorphic-git) to the snapshot before that Turn — sheet / world / dossiers / beats / quests / Scratch / play_state / transcript — then **replaces** the play session and re-primes. A FAIL orphan player row **rewinds** the `fail` commit (player row + any live writes from that torn Turn). If there is no `fail` snapshot for that row (legacy dirty tail), chop the transcript only.

**Continue** (GM rows only; Home Continue is a different word). Confirm first (“Later turns leave the line you play”). Then: Rewind to the snapshot after that Turn if the row is not HEAD → reload story / Scratch / Inspect / Status from disk → replace session → re-prime → hidden Game Master Turn that **finishes that row’s text** (suffix only; the prefix is already the last assistant message and is not sent again as a player line). **No player `(continue)` row.** Stream and SUCCESS stay on the **same GM row**. Composer / Idle after that Turn. Not regenerate (the prefix stays). Empty Enter in the composer is unchanged (player `(continue)` + new GM row). History list (web Inspect Status; TUI `/history`) is the same primitive; labels are turn number + short GM prose, not SHAs. Opening = turn `0`.

**Scratch.** Streamed live during the play Turn (`scratch_live`: thinking + tools). For a local Game Master, live Scratch includes **Answer now** while reasoning is active. It forces the current reasoning block to end and lets the same completion continue into its answer; it does not interrupt the Turn. Atomic ends the block in place; on exl3xpu the host resends with the thought so far closed and splices the answer into the same stream ([ADR-0009](adr/0009-exl3xpu-engine.md)). One jsonl record per play SUCCESS: `{ts, turn, thinking, tools:[{name, path?, wrote?, n?, value?, query?}]}`. Join by GM `ts` + `success_turn_count`. After SUCCESS the live pane collapses; web chevron on the who-label chip expands/collapses the record **above that GM message**. TUI: `/scratch [N]` toggles under the GM block. Edit keeps Scratch; Delete prunes. Continue restores the file from git. Hygiene and rebuild-compaction reuse `scratch_live`; the web story leaf shows their maintenance block open while live and collapsed after completion. The in-memory block remains where maintenance began, so later Turns flow below it. NQ does not persist it to `.nq/scratch.jsonl` or guarantee it across refresh. Not full tool payloads. No raw model/provider envelope.

**Illustration** (web only; [ADR-0007](adr/0007-illustration.md)). Idle. One desk control (overlapped paintbrush + charcoal) above the inkwell. Click rewrites the latest GM row into an Anima prompt (short tag prefix, then one or two prose sentences) via a read-only lookup pass (`read` / `search` / `search_full` on Campaign files — not a play Turn, not a write). The looker is pinned the player sheet and the live dossier catalog (`appearance` on each live FM). It may open a leaf only when that appearance is blank. Watch relative size; `(size difference:2)` when bodies are not the same scale. POST may send `{prompt}` to skip the rewrite and paint that line instead (Regenerate on the easel). `pov, pov hands` only when the player's hands or body belong in the shot; then lock gender (`pov boy, pov male` or `pov female, pov girl`). Prefer one figure when the sitting can focus on them; add a second only when the scene obviously needs both. Each other figure gets a position compared to the viewer. Then local `sd-cli` paints four variants (different seeds) into a 2×2. Scratch/processing shows on the easel legs while the lookup and paints run. Click one sitting: it fills the canvas and is the file that is recorded. POST `/api/illustration/pick` `{slot}` copies that variant to `illustrations/<id>.png`, stamps `illustration` and `illustrationPrompt` on that GM row (`ts`), commits the stamp only (`illustrate`). Leave it / cancel drops the variants with no stamp. Re-click replaces the file. Missing runner/weights → control hidden. Missing file after Rewind → no picture. Not a Game Master tool. Not Inspect. Not TUI v1. Runner + Anima Turbo Q8, Qwen 0.6B encoder, and Qwen Image VAE live in XDG `~/.local/share/nq/anima/` (not in nq git).

**Local GPU handoff.** A per-user Local Inference Host owns NQ-managed Atomic and `sd-cli`. OMP uses its stable llama.cpp endpoint. The installation manifest holds a catalog of registered GGUF models; local files remain in their chosen folder and are referenced by path. For an Illustration with a local Game Master, the host finishes the prompt-rewrite request, stops its verified Atomic process, paints all four variants under one batch, and restores the exact model/context/reasoning profile in `finally`; queued text waits for restoration. Success, failure, cancellation, client loss, and host shutdown all take the same restoration path. A remote Game Master skips Atomic and runs only `sd-cli`. So does an exl3xpu Game Master, which stays loaded and keeps serving text: it runs on the Intel GPU, and NQ's `sd-cli` builds are CUDA.

**Local load diagnostics.** When Atomic exits or misses its readiness deadline, NQ returns the bounded log output from that startup attempt to Home and prints the same failure to the terminal's standard error. The persistent full logs remain under `~/.local/share/nq/local/logs/`; the web book’s **AI log** toggle incrementally tails the fixed engine or inference-host log while its diagnostics drawer is open.

**Inspect Save** (web only). Idle. Raw textarea. `sheet` \| `world` \| `seed` (World tab links: **World info** / **Seed**; saving rebuilds the system prompt via the session replace) \| `dossiers` (index + slug; **create** slug `[a-z0-9-]+`; never delete; archive move is the only path change) \| `beats` \| `quests` \| `twists` (spoiler-veiled: blurred until the player clicks through). Not `status`, `transcript.jsonl`, `campaign.yaml`, `.nq/**`. If the file changed since load → **409** and show disk text. Then commit + session replace. Archive / unarchive is one click on the dossier index or leaf (collapsed **Archives** section). A dossier leaf has **Back to dossiers**; returning preserves the index search. Same move as the GM `archive` tool.

**Manual hygiene.** Inspect Status (last recto tab) and TUI `/light` `/heavy` `/compact` `/fresh`. Same as automatic; a manual pass **resets** the light schedule, so the next automatic Light is N Turns later. Compact = heavy then rebuild with a recent dialogue tail. Fresh = Compact with **no** transcript seeded into the new session. Failures = automatic. Preview-before-apply is fog.

**Two processes.** Last writer wins. Rewind can clobber another `play`/`serve` on the same folder.

---

## 6. Context Assembly (priming)

The Play Loop assembles `systemPrompt` and hard pins from the current files whenever it opens a Campaign. A clean, isolation-aware OMP journal keeps its conversation history but receives the newly assembled prompt and pins. Legacy journals and journals left in maintenance are rebuilt from the player-facing transcript, retaining full history when it fits and otherwise a recent tail. Dossier **bodies** are tools-only. No relevance ranker / embeddings in v1.

### systemPrompt order (binding)

1. Global Game Master voice, bundled `src/play/gm_voice.md` or replaced by `play.gm_voice` / `--gm-voice`: player authorship, turn pacing, moving with companions, dialogue, narration, and table defaults for people. Every rule is followed by a bad/good example pair drawn from invented scenes, because small models follow demonstrated shapes more reliably than abstract instruction. Rebuild handoffs defer to this voice rather than supplying a second style guide.
2. Optional `# Game Master personality` from configuration.
3. `# The Scenario`, then full `seed.md` verbatim: Campaign premise, setting, and Campaign-specific rules.
4. NQ runtime contract: current truth, validity/freedom, memory-file roles, play's read-only tools, rolls, NPC personality generation, and the dossier example. These operational rules remain present with a custom voice. Memory-format instructions are supplied only to Hygiene, not to the shared runtime contract or pinned memory headers.

The voice's examples use invented people, places, and objects rather than material from any real Campaign. Examples lifted from a live Campaign were observed being copied nearly verbatim when play returned to the same scene, which masks whether a rule generalized. A prose-diagnostics section adapted from [jwynia's MIT-licensed prose-style skill](https://github.com/jwynia/agent-skills/blob/e02ec7e226a6e4f8419fd3b88a1d8e472d421b32/skills/creative/fiction/craft/prose-style/SKILL.md) was bundled earlier and retired: it targeted flat and purple prose, which the tested models did not produce, and its advice to write short sentences for punch encouraged the clipped, context-dependent fragments the voice now forbids.

### Hard pins (`contextFiles`)

| Pin                 | Content                                                                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `player_sheet.md`   | Entire file                                                                                                                                                                                                                                   |
| `world-building.md` | Entire file                                                                                                                                                                                                                                   |
| `quest-log.md`      | Entire file                                                                                                                                                                                                                                   |
| `twists.md`         | Entire file                                                                                                                                                                                                                                   |
| `story-beats.md`    | **Entire file** (no cutoff)                                                                                                                                                                                                                   |
| dossier catalog     | Synthetic MD from each live dossier FM: slug, name, aliases, kind, personality, appearance, stub_of→keeper. **No bodies.** Each entry reports how many body lines remain, without prompting a read. Archived omitted. Stubs as pointers only. |

### When to rebuild pins / systemPrompt

| Moment                                                       | Rebuild?                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| New OMP session create (first play or after rebuild-compact) | **Yes**                                                       |
| `continueRecent` / normal resume                             | **Yes**: current files plus clean persisted play history; legacy or unfinished-maintenance journals use transcript reconstruction |
| After Hygiene without compact                                | **No** — the open session keeps its existing prompt and pins  |
| Every Turn                                                   | **No** — only `prompt(player)`                                |

**Pin overflow** (seed + pins cannot fit under `ceiling - completion reserve`): **error out** in POC — no silent truncation.  
**Mid-Turn context overflow:** **FAIL** the Turn (keep files, no gm row). No mid-turn rebuild.

---

## 7. Memory Hygiene

Same play OMP session: NQ issues a **hidden** `prompt(hygiene_instruction)` while UI shows “Memory hygiene…”. The pass sees the existing play conversation and temporarily receives memory-writing tools. On success, error, or cancellation, NQ restores a clean play-history checkpoint and the play tool set. Maintenance instructions, assistant messages, tool calls/results, and the final summary are absent from the next play request and resumed active journal; memory-file changes are retained. No GM transcript row is created. Do **not** rebuild systemPrompt/pins for Hygiene.

| Mode      | When                                                                                        | Emphasis                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Light** | After SUCCESS when `success_turn_count - last_hygiene_success_turn >= N` (default **N = 10**), or player **manual** | Catch up standing facts; author beats + quests + twists using the Hygiene-local memory-format instruction |
| **Heavy** | Mandatory immediately before every rebuild-compact, or player **manual**                    | Light + holistic compress/dedupe/organize through surgical edits; **retain same information**; archive leaves that have left the story |

If both due on one Turn → **heavy only**. Every hygiene pass — automatic Light, manual Light/Heavy, and the Heavy inside a rebuild-compaction — stamps `last_hygiene_success_turn` and therefore **resets** the automatic clock.

**Rewrite targets:** sheet (restore H2s; never move powers off `## Powers`), world-building, dossiers (allowed optional H2s only; surgical edits; merge→stub; never delete), story-beats (**append-only** v1), quest-log (add/delete open items).

**Beats/quests procedure:** NQ supplies transcript range after `last_hygiene_transcript_line`; model reads last ~15–20 beats for continuity; appends one compact factual beat per line; refreshes quest-log. Preserve names, numbers, negation, causality, and qualifiers. Beats are event history; Dossiers hold durable subject facts. A lost item is a beat and an inventory update, not a story retold in the dossier. Sheet Notes and quest bullets are standing facts / open leads, not copies of the last GM paragraph.

**Tools during hygiene:** `read` / `edit` / `write` / `search` / `search_full` / `archive` — **no `roll`**. Use `edit` for existing dossiers and reserve `write` for new dossier creation. Same model as play (except `search_full.*` knobs).

**Failure:** no auto-retry; always log + surface UI/stderr; do not advance `last_hygiene_transcript_line` on fail. Restore clean play history and tools without undoing memory-file changes on success, failure, or cancellation. Light fail → still Idle; **heavy fail → abort rebuild-compact**, keep the clean session.

### `.nq/play_state.json` (minimal)

| Field                          | Meaning                                                |
| ------------------------------ | ------------------------------------------------------ |
| `success_turn_count`           | Incremented on SUCCESS only                            |
| `luck_points`                  | Starts at `5`; armed use subtracts one and a qualifying resolved roll restores one; no maximum |
| `luck_armed`                   | Forces the next valid roll to `n`, then becomes `false`; an armed `d1` spends and restores one point |
| `last_hygiene_success_turn`    | count when last hygiene attempt finished; the Light clock counts Turns from it |
| `last_hygiene_transcript_line` | last transcript row consumed by **successful** hygiene |
| `last_hygiene_at`              | ISO timestamp                                          |
| `last_hygiene_status`          | `ok` \| `fail`                                         |
| `last_hygiene_error`           | short string on fail                                   |
| `last_hygiene_mode`            | `light` \| `heavy`                                     |

NQ writes these — never the model. Retired: `story_beats_cutoff_line`.

---

## 8. Rebuild-compaction

NQ-owned. **OMP `compaction.enabled = false`** on play.

| Setting              | Default                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Trigger              | After SUCCESS on busy path, if estimated OMP context ≥ ceiling; or player **manual Compact** / **Fresh** |
| Effective ceiling    | **128k** tokens (anti-rot), configurable                                                                          |
| Recent dialogue tail | At most `hygiene.n` completed Turns. Drop oldest whole Turns if the context ceiling cannot fit the full interval. |

**Algorithm:**

1. Run **heavy** Memory Hygiene on the same session (mandatory).
2. On hygiene failure → abort compact; keep session; error; Idle.
3. End current play session (old JSONL may remain; no longer `continueRecent`).
4. `createAgentSession` fresh; rebuild systemPrompt + contextFiles (**full** beats).
5. Seed at most the latest `hygiene.n` completed Turns from `transcript.jsonl`, preserving player/GM order, then append the compact history handoff as a `system` message. Keep whole Turns; drop oldest Turns when the remaining context budget, including the handoff, is smaller. If the pins, reserve, and compact handoff cannot fit without dialogue, fail with a context overflow instead of creating an oversized session. The compact handoff says older activity is in pinned Story Beats, the recent dialogue is above it, and a dossier body should be read only when a fact is needed.
6. Full authoring replacements seed the complete transcript when the transcript and full handoff fit. They append the full handoff as a `system` message after the dialogue. An empty full history remains unseeded.
7. **Fresh** (manual only) is Compact except the rebuilt session is seeded with the handoff and **no** transcript rows. The Campaign transcript on disk is unchanged. The fresh handoff says this session has no prior dialogue and older activity is in Story Beats.
8. Compact and full handoffs end with: "Continue as Game Master using the current system voice, not the style of the historical dialogue. Reply only with finished story prose." The fresh handoff ends with: "Continue as Game Master using the current system voice. Reply only with finished story prose."
9. That session is current for subsequent `continueRecent`.

**Retired:** promote-before-evict as a separate pre-compact harvest; beats cutoff truncation; treating compaction as durable memory.

---

## 9. Campaign Sandbox tools

| Tool                      | Play | Hygiene | Role                                                                                                                                           |
| ------------------------- | ---- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `read` / `edit` / `write` | yes  | yes     | Campaign path jail                                                                                                                             |
| `roll`                    | yes  | **no**  | Uniform integer in `[1, n]` (`n` positive int, cap e.g. 1e6). Every result of `1` or `value <= n * 0.05` restores one Luck Point. |
| `search`                  | yes  | yes     | Deterministic substring over prescribed memory MD including `dossiers/archive/` (+ optional seed). Path+line hits. No transcript, no `.nq/**`. |
| `search_full`             | yes  | yes     | Short-lived subagent over memory MD + transcript + root notes + seed. Never `.nq/**`. Config: `search_full.model`, `search_full.reasoning`.    |
| `archive`                 | yes  | yes     | Move a Dossier to `dossiers/archive/<slug>.md` (`archive=true`, default) or back (`archive=false`). Same slug. Catalog pin is live only.       |

No bash, web, or LSP on the play path.

---

## 10. CLI and Player Surfaces

Single binary **`nq`**. OMP is embed-only. Surfaces: [ADR-0004](adr/0004-dual-player-surfaces.md).

| Command                                 | Role                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `nq new <path> --pack <dir> [--name …]` | Materialize Campaign from Seed Pack                                         |
| `nq delete [path] [--yes]`              | Permanently remove a Campaign folder after confirmation                     |
| `nq play [path]`                        | OpenTUI Player Surface (Home, or play if a Campaign is given)               |
| `nq serve [path]`                       | Localhost web Player Surface (Preact; Home, or play if a Campaign is given) |
| `nq turn [path] [-p text]`              | One non-interactive Turn, then exit                                         |
| `nq show [path] [target]`               | Read-only inspection (no session)                                           |

- **No** separate `resume` command — Home **Continue** is the player path; `play` / `serve` `<path>` still resume-by-path for scripts.
- `play`, `serve`, and `turn` **never share a process**. One Campaign **at a time** per play/serve process (Leave → Home tears down the Play Loop).
- Path optional on play/serve/turn/show: if given, or cwd has `campaign.yaml`, **skip Home** and open that Campaign. Bare `nq play` / `nq serve` with no Campaign → **Home**.
- **No lock file** — last writer wins (document the footgun).
- Global flags: `-d` / `--debug`, `--log <path>`, `--timeout <sec>`, `--model <id>`.
- Config: XDG `~/.config/nq/config.toml` (flags override). Holds model, debug, log, timeout (default 180s), `hygiene.n` (10), `search_full.*`, `play.transcript_tail`, `play.gm_personality`, `local.thinking_opener`, `[serve] port` / `host`, `compact.ceiling` / `compact.seed_percent`, compact tail, etc. — **not** `campaign.yaml`. Default Campaign library: XDG data `~/.local/share/nq/campaigns/` ([ADR-0005](adr/0005-player-home.md)). GM personality is added to the Game Master system prompt for every provider. Local turns use a `reasoning_content` continuation; `local.thinking_opener` replaces the built-in numbered step-by-step prefix when set. The local adapter removes one leading `Final answer:` protocol label if the model emits it after reasoning.

**Exit codes:** `0` success / clean Idle quit / clean `serve` Ctrl+C; `1` error / FAIL / missing Campaign or seed on play|serve|turn / bind failure; `130` SIGINT on `turn` only.

**Streaming:** NQ/OMP session events only. Default visible: `turn_started`, `prose_delta`, `turn_ended`, errors/status. Debug → full agent dump on stderr; `--log` mirrors. Errors (including hygiene) always to UI/stderr and log when configured. **No** prose strip filter. **No markdown render** of GM/player prose on either surface.

### Play Kernel

Both Player Surfaces interpret one **pure** Play Kernel (not Effect, not Preact): fold of `PlayEvent` → `phase`, `story`, `draft`, `status`, `lastError`, `busy`, `successTurnCount`. Commands: `submit`, `interrupt`. No `quit`, no Inspect, no Home, no Edit / Continue / Rewind.

Effect **`PlaySession`** wraps Promise `PlayLoop` (`acquireRelease`, `tryPromise`). Events fan out on a **sliding PubSub** → `Stream.fromPubSub`. Open fails the Effect (`MissingSeedError`); Turn FAIL stays a `PlayEvent`. `FakeAgentFactory` via a test Layer. `runPromise` only at the OpenTUI/`Layer.launch` edge.

### `nq play` (OpenTUI)

- Pin `@opentui/core` (exact, Bun ≥1.3). Native load fail → exit 1. **No readline fallback.**
- Alternate-screen **play chrome**: `ScrollBox` (sticky bottom) + status line + single-line `Input`. No inspect, no debug pane, no header bar, no pack/provider widgets on the story. No Inspect write (book only).
- Bare `nq play` (no Campaign) → **Home** first: sign in, Continue, New adventure. Leave from Idle (`/quit` etc.) **returns to Home**, not the shell. Home exit (second quit / explicit leave Home) → exit 0.
- Open: transcript tail (default last **20** rows; `--tail` / `--full`) → Idle. Empty transcript: copy `seed.md` `## Opening message` once (same as today).
- Missing `seed.md` → exit 1 before Idle.
- Empty Enter → `(continue)` (player row + new GM row — **not** GM-row Continue). Idle `/quit` `/exit` `/leave` `/bye`, Ctrl+C, Ctrl+D → Leave → Home.
- Idle authoring slashes (dim **turn** numbers on GM rows; opening = `0`): `/edit` `[N]`, `/delete`, `/continue` `[N]` (`y/N` then Rewind + extend), `/scratch` `[N]` (toggle under that GM block), `/history`, `/light` `/heavy` `/compact` `/fresh`. Bare `/edit` = last row; `/edit N` = that Turn’s GM; older player rows → use `nq serve`. Edit = temporary multi-line overlay (save / Esc). No `$EDITOR`. No row-focus mode.
- Turning: stream `draft`; input locked; story scroll still works; Ctrl+C → FAIL → Idle.
- Hygiene: status “Memory hygiene…”; still busy.
- `-d` on stderr only.

### `nq delete`

- Path optional: default **cwd** if `campaign.yaml` present.
- Validates `campaign.yaml` before any removal; refuses non-Campaign paths.
- Interactive confirm: print name, id, path; ask **Are you sure? [y/N]**. Only `y` / `yes` proceeds; anything else (including empty Enter) cancels, exit 1, folder kept.
- Non-TTY without `--yes` / `-y` → refuse, exit 1 (no silent delete).
- `--yes` / `-y` skips the prompt (scripts/automation only).
- On success: recursively remove the Campaign directory; print deleted name/id/path; exit 0.
- Alias: `nq rm`.

### `nq serve`

- Bind **`127.0.0.1`** by default; **`--host <addr>`** or `[serve] host` (flag wins) rebinds, e.g. `0.0.0.0` to reach the page from a phone on the LAN. **`--port`** default **7737** or `[serve] port` (flag wins). Port taken → exit 1, no hop.
- **`--tail` / `--full`** — snapshot story length (same `[play] transcript_tail`). **`--open`** opens a browser; **off by default** (no config key).
- Print `http://<host>:<port>/`; when bound to `0.0.0.0`, also print one URL per non-internal IPv4 address. If a Campaign is open, also print its name/path. Block until Ctrl+C → Scope teardown → exit 0.
- Bare `nq serve` (no Campaign) → **Home** at `/`. A path (or cwd Campaign) skips Home and opens the book on that Campaign.
- Page: **Preact**. In-repo HTML/CSS/TS, Bun serves `GET /`. No Vite, no CDN, no Effect in the browser.
- **Home** (sibling of the book): sign in, Continue, New adventure, and a Settings gear for every XDG config value. Each Continue row can permanently delete its Campaign folder after a confirmation that names the disk deletion and states it cannot be undone. Settings persist to `config.toml` without discarding unknown keys or comments and apply to the next Campaign opened; `[serve] port` applies after restart. Leave from play returns to Home; Play Loop tears down.
- Play chrome: **open book** — story verso, Inspect recto; one leaf under ~800px. Raw prose (`white-space: pre-wrap`). Multi-line composer: **Enter submits**; Shift/Ctrl/Cmd+Enter newline. No folio numbers. No pack/provider widgets on the spread. The spread sits on a painted writing desk with a candle; estimated working-leaf fullness (OMP session occupancy vs NQ `[compact] ceiling`, never the model window) is the inkwell on that desk, whose ink drops as the session fills — not a token HUD. Overlapped paintbrush + charcoal invoke Illustration. A small **AI log** header toggle opens a bounded, follow-tail diagnostics drawer for the two fixed local inference logs; it is dormant while closed.
- HTTP (no auth, no CORS):

| Method | Path                                          | Role                                                                                                                                                                          |
| ------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/`                                           | Page (Home or book; client chooses from snapshot)                                                                                                                             |
| `GET`  | `/api/home`                                   | Home snapshot: signed-in Provider/Model display names, Campaign list, Seed Pack list, effective settings                                                                      |
| `POST` | `/api/login`                                  | Start in-process Provider login (display name / short-row id). Progress via events.                                                                                           |
| `POST` | `/api/login/prompt`                           | Complete an `onPrompt` / paste-key / manual-code step.                                                                                                                        |
| `POST` | `/api/campaigns`                              | Birth from a Seed Pack + title → 201 + open that Campaign                                                                                                                     |
| `POST` | `/api/campaigns/open`                         | Open an existing default-dir Campaign by id                                                                                                                                   |
| `POST` | `/api/campaigns/delete`                       | Permanently delete an existing default-dir Campaign folder by id after the surface confirms; 204 / 404 missing                                                                |
| `POST` | `/api/settings`                               | Validate and persist the complete Home settings object; update the active config for the next Campaign                                                                        |
| `POST` | `/api/leave`                                  | Tear down Play Loop → Home. 204.                                                                                                                                              |
| `GET`  | `/api/events`                                 | NDJSON: kernel snapshot line, then `PlayEvent` 1:1 (no `agent_debug` unless `-d`)                                                                                             |
| `GET`  | `/api/local/log?source=engine\|host&offset=N` | Bounded incremental tail of a fixed local inference log; no arbitrary paths                                                                                                   |
| `POST` | `/api/turn`                                   | `{ "text" }` → 202 or 409 busy. Does not wait for prose.                                                                                                                      |
| `POST` | `/api/luck`                                   | Idle only. `{ armed: boolean }` arms or disarms the next-roll maximum. 200 / 400 / 409 busy                                                                                    |
| `POST` | `/api/interrupt`                              | 204. Only browser interrupt.                                                                                                                                                  |
| `POST` | `/api/reasoning/end`                          | Local Game Master only (Atomic in place; exl3xpu by resend). Force the active reasoning block to end and continue the same completion. 204 / 409.                             |
| `GET`  | `/api/inspect/…`                              | `showCampaign` JSON minus transcript                                                                                                                                          |
| `PUT`  | `/api/inspect/…`                              | Idle Save raw body. 409 if disk changed since load. 409 if busy                                                                                                               |
| `POST` | `/api/inspect/dossiers`                       | Create dossier `{ slug, body? }`. 201 / 409                                                                                                                                   |
| `POST` | `/api/transcript/edit`                        | `{ ts, text }` Idle. Surgical. 409 if busy                                                                                                                                    |
| `POST` | `/api/transcript/delete`                      | Last row or last pair only. 409 if busy / not last                                                                                                                            |
| `GET`  | `/api/history`                                | Reachable snapshots: turn + prose (not SHAs)                                                                                                                                  |
| `POST` | `/api/continue`                               | `{ turn }` after client confirm. `turn` is the `listGmTurns` number stamped on that GM row (not `success_turn_count`). Rewind if needed + extend that GM row. 202 / 409 / 404 |
| `POST` | `/api/hygiene`                                | `{ mode: "light" \| "heavy" \| "compact" }`. 202 / 409 busy                                                                                                                   |

- Stream drop / tab close does **not** interrupt. POSTs require an `http:` `Origin`. Over loopback (`Host` is `127.0.0.1`/`localhost`) either loopback spelling is accepted; over any other `Host` (LAN bind) the Origin must equal `Host` exactly. Missing/other Origin → 403.
- **Inspect** (web only): `status` \| `sheet` \| `world` \| `seed` (World tab links: **World info** / **Seed**; saving rebuilds the system prompt via the session replace) \| `dossiers` (+ slug) \| `beats` \| `quests` \| `twists`. Pull on open/focus. GET OK while Turning. **Save**, create-dossier, and Luck Point changes are **Idle only**. Preformatted raw textarea. Status tab (last): Campaign facts + Luck Points + Light / Heavy / Compact + Roll Log + history list. Not in the Play Kernel.
- **Home** (both surfaces): in-process `AuthStorage.login` + `getOAuthProviders()`. Short row Grok / Claude / ChatGPT / This computer + More…. Player-facing display names only. Model chosen after Provider. **This computer** appears when an NQ local runtime has at least one registered model; Home startup does not start Atomic. EXL3 model folders in the model directories are listed too and run on the exl3xpu engine, which the setup modal downloads in the background when missing ([ADR-0009](adr/0009-exl3xpu-engine.md)). Each local model keeps its own engine profile (context, reasoning budget, cache types, RAM cache, flash attention, card and backend) in `local_profiles.json` beside the config, saved when the player loads it and used by Resume and `nq turn`; an unsaved model starts from the global settings on the card that fits it: the installed engine's card when it holds the weights, else the largest card that does (Intel through Vulkan with flash attention off), else the installed engine spilling to RAM. Choosing it opens a focused setup modal for the registered model, context window, Atomic reasoning-token budget, and play thinking level. Confirming that modal—or opening or creating a Campaign whose saved selection is local—immediately opens a modal loading state, makes the rest of Home inert, streams the latest startup phase, and offers cancellation. The loading modal remains until the exact Local Inference Host profile is ready or startup fails/cancels; only then may the Campaign open or the selection persist. Remote selection leaves Atomic stopped. See [ADR-0005](adr/0005-player-home.md).

### `nq turn`

- `-p` / stdin; empty → `(continue)`.
- Buffer GM prose; **stdout only on SUCCESS**. FAIL → empty stdout, stderr message, exit 1.
- SIGINT → FAIL → exit 130.
- Hygiene runs sync before exit when triggered.

### `nq show`

- Default target `status` (name, id, `success_turn_count`, skeleton presence).
- Targets: `status` | `sheet` | `world` | `dossiers` | `beats` | `quests` | `twists` | `transcript`.
- `dossiers` index (slug + optional name); `dossiers <slug>` → body.
- Does not require `seed.md`; no OMP session; no play_state writes.

---

## 11. Seed Pack

Directory contract for `nq new` — not a live Campaign.

```
<seed-pack>/
  seed.md              # required → Campaign seed.md
  player_sheet.md      # required → sheet + ensure H2s
  world-building.md    # optional
  dossiers/*.md        # optional
  pack.yaml            # optional author meta; not copied
  …                    # ignored
```

```text
nq new <campaign-path> --pack <seed-pack-dir> [--name <display-name>]
```

- `--pack` required on the CLI. Fail if campaign path exists and is **non-empty**. Never clobber.
- Fail if pack missing `seed.md` or `player_sheet.md`.
- Campaign `name`: `--name`, else Home title field (default = pack display name), else basename of path.
- Stamp `campaign.yaml`; copy seed; copy sheet then **append** any missing H2s; world-building copy or empty stub; dossiers copy or empty dir; empty beats, quest-log, transcript; `.nq/sessions/`; play_state lazy OK; **git init** + birth commit; `.gitignore` with `.nq/sessions/` and `illustrations/`.
- No pack provenance fields on Campaign in v1.
- `seed.md` is freeform author content. Optional H2 **`## Opening message`**: player-facing prose NQ may copy into an empty transcript on first `play`/`PlayLoop.open` (see §10). Body ends at the next `## ` heading. Missing/blank → no auto row. Copy **commits** (opening = turn `0`).
- No product-locked example PC.
- **Home New adventure** lists every valid directory under install/repo `packs/` (required files present). Card: `pack.yaml` `name` + `description` if present, else title-case folder; sort by display name. `pack.yaml` still not copied.
- **`packs/` is player-facing only.** Eval Seed Pack lives under `tests/` (see [Testing strategy](#15-testing-strategy)), not `packs/`. Private packs (e.g. Fredicus) may exist locally in `packs/` and must not be committed.
- Home **New** births into `~/.local/share/nq/campaigns/<slug>-<shortid>/` using the same copy rules. **Continue** lists that directory by Campaign name. Both Home surfaces can delete a listed Campaign only after warning that the complete folder will be removed from disk and cannot be recovered.

After birth: sheet is sole PC SoT; `seed.md` is premise/voice (plus optional opening message).

---

## 12. Config defaults (user / flags)

| Knob                                         | Default                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn inactivity timeout                      | 180s without model or tool activity                                                                                                                                                                                                                                              |
| `hygiene.n`                                  | 10 — light Hygiene interval and maximum recent Turns retained after a rebuild                                                                                                                                                                                                    |
| Rebuild-compact ceiling (`compact.ceiling`) | **30k** tokens. Loading a local model lowers the saved ceiling to 80% of its context when it is higher, so compaction comes before the engine overflows. A surface may fix it (the Hosted book). |
| `max_tokens` / `--max-tokens` | **8192** — the most a llama.cpp-family Game Master (this computer, a remote llama-server) or the Hosted book writes in one call, thinking and tool calls included, so a model that never stops fails fast. Cloud providers keep their own limits. Changeable from Home Settings, the in-book Settings leaf and `/set`; fixed on the Hosted book. |
| `compact.seed_percent`                       | 50 — percent of the ceiling a rebuilt session may occupy (system prompt + pins + handoff + tail). Pins are never trimmed, so the clamp only shortens the transcript tail; when the pins alone fill it no tail is seeded and the Play Loop emits an error naming the overflow. |
| `play.transcript_tail` (play/serve snapshot) | 20 rows                                                                                                                                                                                                                                                                          |
| `play.gm_voice` / `--gm-voice`               | bundled `src/play/gm_voice.md` (prepended)                                                                                                                                                                                                                                      |
| `play.reasoning` / `--reasoning`             | **low** — OMP thinking effort for play and hygiene (`off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `auto`). Home offers the Model's OMP `thinking.efforts`, then the [models.dev](https://models.dev) effort ladder if OMP has no controllable levels. |
| Local Atomic reasoning budget                | **Unrestricted** (`-1`). The Turn inactivity timeout catches stalled streams without capping healthy reasoning.                                                                                                                                                                  |
| `serve.port`                                 | 7737                                                                                                                                                                                                                                                                             |
| `search_full.model`                          | cheaper/faster profile or inherit play                                                                                                                                                                                                                                           |
| `search_full.reasoning`                      | configurable provider ladder                                                                                                                                                                                                                                                     |
| Play/hygiene model                           | Home Model pick / `--model` / config                                                                                                                                                                                                                                             |
| Default Campaign library                     | XDG data `~/.local/share/nq/campaigns/`                                                                                                                                                                                                                                          |

Tokenizer/estimator: use whatever OMP/provider estimation the embed already exposes (or one documented NQ estimator) — pick one and stick to it ([Open questions](#open-questions)).

---

## 13. Definition of done — build-ready

Implementation may start when this spec + ADRs are accepted as law for v1 POC.

### Must not reopen

- Hybrid OMP embed + NQ-owned Play Loop/UI ([ADR-0002](adr/0002-hybrid-omp-agent-campaign-folder.md))
- Package cut: `pi-coding-agent@17.0.9` / `createAgentSession` / allowlist / no stock play compact
- Campaign folder memory contract ([ADR-0003](adr/0003-campaign-folder-memory-contract.md))
- Live-through Turns; FAIL keeps the accepted player transcript row and commits `fail`; no regenerate in POC; no automatic undo of a torn Turn (Delete Rewinds the `fail` commit)
- Context pin set, prime-only-on-session-create, rebuild-compact algorithm + defaults
- Memory Hygiene light/heavy same-session model + play_state fields
- Sandbox tool set and path denies
- CLI command set and story-only surface rules
- Dual Player Surfaces, Play Kernel, Effect `PlaySession` + sliding PubSub, localhost `nq serve` ([ADR-0004](adr/0004-dual-player-surfaces.md))
- OpenTUI play chrome; Preact book page; raw prose; Inspect contract (Idle Save; TUI has no Inspect write)
- Player **Home** (sign-in, Continue, New); play chrome stays story-only ([ADR-0005](adr/0005-player-home.md))
- Play authoring: Edit / Delete / Continue-extend / Scratch / manual hygiene / isomorphic-git Rewind ([ADR-0006](adr/0006-play-authoring.md))
- Five surface test layers (kernel, adapter, mocked web, mocked OpenTUI, HTTP)
- Seed Pack path contract and `nq new` materialization rules
- Glossary terms in `CONTEXT.md`

### Implementer latitude

- Repo/module layout, language/tooling details within the embed stack
- Exact tokenizer/estimator wiring
- Default concrete model id strings / provider profile names
- Logging/telemetry internals beyond the mandated stderr/log surfaces
- Exact file paths under `src/surfaces/web/client/`; `Effect.Service` vs `Context.Tag` spelling
- Typeface / CSS toolkit for the book spread
- Whether `PlayEvent` is encoded with Effect Schema
- XDG config key spelling where not already named above
- Enforcement mechanism details for path jail (`tool_call` vs wrap) as long as policy holds
- Per-prompt tool scoping for omitting `roll` during hygiene vs instruction-only
- Exact SVG/CSS for the who-label chip icons
- isomorphic-git commit message strings; exact Edit-overlay save chord (Esc cancels)

---

## 14. Open questions

In-scope but undecided — do not block POC start; resolve in impl or a later revision:

- Tokenizer/estimator choice for ceiling and tail
- Long-term: GM ad-hoc root notes vs prescribed files only (lean: prefer prescribed + dossiers)
- Hard-readonly `seed.md` in sandbox vs convention-only (v1 = convention)
- Depth of local Bonsai swap runbook in-tree vs later
- Adult-content policy: prompt text vs first-class config
- Export/share/backup of a Campaign folder
- Whether mnemopi/hindsight ever sits beside file memory (default lean: no for v1)
- Exact default `search_full.model` id string
- Book typeface / CSS toolkit
- Effect Schema for `PlayEvent`
- Accessibility specifics for web and TUI
- Hygiene/compact **preview-before-apply**
- Token/pressure meter; search/jump in the story; export a passage
- Align empty Enter with hidden GM-row Continue (v1 they differ)

---

## 15. Testing strategy

Control plane, memory eval, and play smoke stay. Surface layers sit beside them. Do not collapse them.

| Layer                    | What it proves                                                                                         | How                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| **Control plane**        | When hygiene/compact fire, cursors, FAIL paths, session replace, discarded hygiene text                | `bun test` + `FakeAgentFactory`. No live model.                 |
| **Memory quality**       | Hygiene actually rewrote the right files; rebuild-compaction recall survives a dropped transcript tail | Opt-in live eval against a real Provider (default **Grok 4.6**) |
| **Play smoke**           | A human can open Home, sign in, New from `packs/`, and play                                            | Manual. Not an eval bar.                                        |
| **Play Kernel unit**     | fold of `PlayEvent` → story/draft/busy                                                                 | Pure function; scripted events                                  |
| **Adapter + fake agent** | Scope, submit/interrupt, PubSub, open-fail                                                             | `PlaySession` + `FakeAgentFactory` Layer                        |
| **Mocked web UI**        | book chrome, Enter vs Shift+Enter, inspect Save/409, hover Edit/Continue, Scratch collapse             | happy-dom + `@testing-library/preact`                           |
| **Mocked OpenTUI**       | story/status/input, draft, Ctrl+C, quit, slash authoring                                               | `createTestRenderer` + `mockInput` / `captureCharFrame`         |
| **HTTP `nq serve`**      | snapshot NDJSON, 202/409, interrupt 204, Origin 403, inspect GET/PUT, continue, hygiene                | `HttpApp.toWebHandler` or `layerTest`                           |

Surface UI tests use **Brinewatch** names and `dirty-midgame` for inspect. **No Fredicus.** No live Provider. No Playwright / screenshot-only bar.

**Test Seed Pack:** `tests/eval/packs/memory-gym` — tiny Brinewatch premise with planted canary strings (`CANARY-BELL-7E`, `Salt-lung`, `Tide Choir`, `Mira Venn`, `Kell Reed`). Playable, but authored for scoring, not adventure. Not listed on Home.

**Dirty fixture:** `tests/eval/fixtures/dirty-midgame/` is overlaid _after_ `nq new` (Seed Packs cannot ship a midgame transcript). It plants: missing `## Powers`, token only in transcript, resolved lemon quest still listed, duplicate Kell dossiers, tripled Tide Choir copy, sparse Story Beats.

**Live runner:** `bun run eval:memory -- --model xai-oauth/grok-4.6`. Isolated PlayLoop hooks (`runHygienePass`, `runRebuildCompaction`) invoke hygiene/compact **without** a contaminating play Turn. Compact then asks one probe Turn whose answer is the stamp. Scoring is deterministic canary greps on Campaign files (plus probe substring). Not a second-model judge. Not part of CI.

**Long session:** `packs/brinewatch` plus `--scenario long` births a generated player-facing transcript ≥ 40k tokens (POC estimator: chars/4) and rebuild-compacts with the latest `hygiene.n` Turns, so early canaries (`CANARY-BELL-7E`) are not in the rebuilt session. Short compact uses the same Turn-bounded rule.

**Eval bar (v1):** a scenario passes when every **hard** check in `tests/eval/score.ts` passes. Soft checks (Mira alias catch-up, world dedupe) are reported and do not fail the run.

**PlayLoop hooks** exist for eval/tests only — not CLI commands.

---

## 16. Bibliography (research constraints)

Cite; do not treat as product law over this spec:

- [Grok API turn constraints](research/grok-api-turn-constraints.md)
- [Bonsai local inference envelope](research/bonsai-local-inference-envelope.md)
- [Long-horizon agent memory patterns](research/long-horizon-agent-memory-patterns.md)
- [OMP package cut and embed](research/omp-package-cut-and-embed.md)
- [Effect + Bun HTTP envelope](research/effect-bun-http-envelope.md)
- [OpenTUI + Bun and testability](research/opentui-bun-and-testability.md)
- [Mocked UI test stacks](research/mocked-ui-test-stacks.md)
- [Effect adapter best practices](research/effect-adapter-best-practices.md)
- [Campaign git history](research/campaign-git-history.md)
- [OMP session branch](research/omp-session-branch.md)

Wayfinding detail and grill history (non-normative once this spec lands): [`.scratch/neverending-quest/`](../.scratch/neverending-quest/map.md), [`.scratch/nq-player-surfaces/`](../.scratch/nq-player-surfaces/map.md), [`.scratch/nq-play-authoring/`](../.scratch/nq-play-authoring/map.md).

---

## 17. ADR index

| ADR                                                  | Status                 | Topic                                                                                           |
| ---------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| [0001](adr/0001-provider-chat-completions-port.md)   | **Superseded** by 0002 | NQ-owned Chat Completions Provider port (pre-pivot)                                             |
| [0002](adr/0002-hybrid-omp-agent-campaign-folder.md) | Accepted               | Hybrid OMP agent + Campaign folder; package cut                                                 |
| [0003](adr/0003-campaign-folder-memory-contract.md)  | Accepted               | Prescribed memory tree, roles, sandbox path policy                                              |
| [0004](adr/0004-dual-player-surfaces.md)             | Accepted               | Dual Player Surfaces, Play Kernel, Effect surface layer, localhost serve, Preact page           |
| [0005](adr/0005-player-home.md)                      | Accepted               | Home: in-surface sign-in, Continue, New; play chrome unchanged                                  |
| [0006](adr/0006-play-authoring.md)                   | Accepted               | Play authoring: Inspect write, Scratch, transcript Edit, isomorphic-git Rewind, Continue-extend |
| [0007](adr/0007-illustration.md)                     | Accepted               | Illustration: a local picture tied to a GM row, outside Campaign git history                    |
| [0008](adr/0008-hosted-browser-play.md)              | Accepted               | Hosted play in the browser behind a ciphertext relay                                            |
| [0009](adr/0009-exl3xpu-engine.md)                   | Accepted               | EXL3 models on exl3xpu beside Atomic                                                            |
| [0010](adr/0010-layered-source-and-workspace-packages.md) | Accepted          | Layered source tree, workspace packages, ports for the Game Master and the painter              |
| [0011](adr/0011-player-surfaces-at-parity.md)       | Accepted               | Every Player Surface offers the same play and Home; reopens ADR-0006 on TUI Inspect write      |
