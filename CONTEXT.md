# Neverending Quest

Long-running AI Game Master play: a player inhabits a character in a persistent world while the system fights context rot with written memory kept as files in a Campaign folder.

## Language

**Game Master**:
The AI that narrates consequences of player actions and maintains Campaign memory files. Not a referee of hard rules.
_Avoid_: DM, narrator, assistant, bot

**Campaign**:
One continuous playthrough — the durable unit of progress. On disk it is a **folder** (Player Sheet, Dossiers, World-Building, Story Beats, Quest Log, transcript, seed/instructions) resumed by path/id.
_Avoid_: session, save, run, game (when meaning the save unit); project (OMP jargon unless referring to cwd)

**Turn**:
One player input plus the Game Master’s player-facing reply after the agent may have taken multiple inner tool rounds against the Campaign folder.
_Avoid_: message pair, step, generation, agent run (unless meaning the inner OMP run)

**Dossier**:
A named, updated record for a recurring person, place, or other entity the Game Master must not forget. Identity is required frontmatter (`name`, `aliases`, `kind`) and the filename slug. Its body contains only optional `Inventory` (people), `Relationships`, `Abilities`, `Quirks`, and `Establishment` (places) sections. New Dossiers start with each applicable heading empty. Events and recent actions belong in Story Beats. Existing Dossiers receive surgical edits; whole-file writes only create a new Dossier. Live path is `dossiers/<slug>.md`; archived path is `dossiers/archive/<slug>.md` — that move is the only allowed path change. Never delete; never two files with the same slug.
_Avoid_: profile, card, wiki page, entity record

**Archive**:
A cold Dossier: same slug, file under `dossiers/archive/`. Search still finds it; the catalog pin does not. The player can see it in a collapsed Inspect/Seek section and archive or unarchive with one click. Not a delete and not a merge stub.
_Avoid_: trash, hide, stub, cold storage (alone), retire

**Ultra**:
The compact factual register used only when Memory Hygiene writes Campaign memory. It preserves exact facts, names, numbers, negation, causality, and scope or time qualifiers; it is not a register for Game Master reasoning or player-facing prose.
_Avoid_: shorthand, terse voice, compressed story prose

**Story Beats**:
A chronicle of past play (`story-beats.md`), with one compact factual line per beat. Memory Hygiene records events here; Dossiers hold the current, durable facts resulting from them.
_Avoid_: Episodic Memory, event log, journal, session recap, second transcript

**Quest Log**:
A simple open bullet list (`quest-log.md`) of actionable branches — rumors, leads, and pursuits the player could follow up. Resolved or dead entries are deleted, not archived.
_Avoid_: Episodic Memory, quest journal with history, backlog, side-quest tracker (product baggage)

**World-Building**:
A prescribed Campaign root file (`world-building.md`) for factions, ongoing events, monster ecology, and other setting facts that are not a single person/place Dossier. Material graduates into a Dossier only when it becomes a recurring person or place.
_Avoid_: lore bible (ambiguous with seed), wiki, codex, setting doc (alone)

**Player Sheet**:
Privileged singleton Campaign file (`player_sheet.md`) — durable baseline for standing PC facts. Recent successful dialogue may be newer until Memory Hygiene catches it up. Required sections by convention: Description, Inventory, Powers, Notes. Entire file is always primed. Not a Dossier.
_Avoid_: Player Summary (prompt label only), character sheet (tabletop baggage), stats block, `dossiers/player`

**Seed Pack**:
A directory `nq new` materializes a Campaign from — required `seed.md` + `player_sheet.md`, optional `world-building.md` / `dossiers/*` / `pack.yaml`. Freeform file bodies; not a live playthrough.
_Avoid_: module, scenario, premise pack, template pack, campaign template

**Play Loop**:
NQ-owned control flow that accepts player input, runs the embedded agent against the Campaign folder, commits durable file changes, and emits only player-facing prose to a Player Surface.
_Avoid_: Turn loop alone (too easy to confuse with a single completion); agent session (OMP object — implementation)

**Player Surface**:
An NQ-owned player-facing client: **Home**, then one Campaign in play (story prose, minimal status, Turn input). The surfaces are the OpenTUI `nq play` client, the Bun-served local web page (`nq serve`), and the **Hosted book**. Every surface offers the same play: Inspect (Idle-writable), Scratch, Rewind and Continue, Retry, Luck Points and the Roll Log, Illustration, and Memory Hygiene by hand. The book sits on a painted writing desk (candle, inkwell). The well marks estimated working-leaf fullness (OMP session occupancy vs NQ compact ceiling) — ink remaining, not a token counter. Overlapped paintbrush and charcoal above the well request an Illustration. Not the Play Loop, not `nq show`, not the OMP session.
_Avoid_: UI (alone), client, frontend, game client, omp TUI

**Hosted book**:
The web Player Surface served publicly from Cloudflare, with the Play Loop and the Campaign folder running in the player's browser. It has one fixed Game Master the relay chooses: no sign-in, no Model choice. No Campaign is stored server-side.
_Avoid_: cloud version, SaaS, online mode, web app (alone)

**Relay**:
The stateless Cloudflare Worker behind the Hosted book. It holds the inference key and forwards sealed requests to the Game Master's GPU worker, seeing only ciphertext. Not a server-side Play Loop and not storage.
_Avoid_: backend, proxy server, API server

**Home**:
Pre-play screen on both Player Surfaces — sign in (Provider + Model), Continue (Campaigns by name), New adventure (Seed Packs in `packs/`). Surface-owned, like quit. Not the Play Kernel, not Inspect, not play chrome. Not the GM-row **Continue** (that Rewinds and extends a Turn).
_Avoid_: launcher, setup wizard, main menu, lobby, campaign picker (alone)

**Play Kernel**:
The shared player-facing play state and commands both Player Surfaces interpret. A pure fold of Play Events into story, live draft, phase, status, and busy; commands are `submit` and `interrupt` only. Not the Play Loop, not Inspect, not process quit.
_Avoid_: view-model, UI state, store, reducer (implementation)

**Inspect**:
The web Player Surface’s view of Campaign memory — `nq show` targets except transcript (sheet, world, dossiers, beats, quests, status). Pull-on-look. The player may **write** sheet, world, dossiers, beats, and quests (Idle Save), and archive or unarchive a Dossier. Not the story pane. Not `seed.md` / `campaign.yaml` / `.nq/**`. Not Illustrations.
_Avoid_: dossier browser, memory panel, wiki, inspector (devtools)

**Illustration**:
A player-requested picture of a play moment, tied to a Game Master transcript row by id. The picture file lives in the Campaign folder but is not Campaign git history. Not Inspect, not primed, not a Game Master tool.
_Avoid_: art, render, screenshot, regenerate, scene image

**Scratch**:
Inner work of one play Turn — thinking plus tool name, path, roll purpose and `n`→value, and wrote — streamed live during Turning, then stored in `.nq/scratch.jsonl` on SUCCESS and joined to that Turn’s GM transcript row (`ts` + turn count). After SUCCESS it is collapsed until the player expands it (book: chevron on the who-label chip; opens **above** that GM message). Not player-facing story. Not Story Beats. Not the OMP session journal. Not full tool payloads.
_Avoid_: thinking dump, tool trace, debug log, episodic

**Roll Log**:
The player-visible, newest-first history of completed rolls across the Campaign. Each entry names its Turn, die, result, and the Game Master’s stated purpose. A missing purpose is shown honestly rather than inferred. Available from Status on the web Player Surface. Not Scratch itself, Story Beats, or a rules adjudication record.
_Avoid_: dice history, combat log, audit log

**Luck Point**:
A Campaign cheat the player may arm or disarm from Status while Idle. Every Campaign begins with five, and the balance has no maximum. When armed, the next valid Game Master roll returns its highest possible result and spends one point. Every resolved Game Master roll of `1`, or no more than five percent of its die size, restores exactly one point. This includes an armed `d1`, which spends and restores a point. Luck stays armed across Turns with no roll, disarms after use, and cannot be armed at zero. Rewind restores the count and armed state from that Campaign snapshot, except that Retry keeps a point the player armed before retrying. Not a Player Sheet power, an instruction to the Game Master, or a reroll.
_Avoid_: inspiration, advantage, fate token, lucky roll

**Rewind**:
Idle player action that points the Campaign branch at an earlier SUCCESS (or opening) snapshot via in-process git, then replaces the play session and re-primes. The GM-row **Continue** button is Rewind plus a hidden Turn that finishes that same GM row (suffix only; the prefix is not sent again as a player line). Delete of a FAIL tail Rewinds that `fail` commit (player row + live writes). Not automatic undo on cancel. Players do not run `git`.
_Avoid_: checkout, reset, revert, undo, time travel (alone)

**Campaign Sandbox**:
The restriction that the Game Master may only use allowlisted tools inside the Campaign folder. A play Turn is read-only: filesystem **`read`**, generic **`roll`** entropy, deterministic **`search`** over prescribed memory markdown, and **`search_full`** over memory plus player transcript. Memory Hygiene replaces that set with `read` / `edit` / `write` / `search` / `search_full` / `archive`; it has no `roll`. Neither mode gets bash, web, or repo escape.
_Avoid_: jail, container (unless a real OS sandbox is added later)

**Context Assembly**:
The policy that builds what the Game Master session sees: global table voice, then Campaign seed, then the runtime contract; hard-pinned Campaign files (including full Story Beats); dossier catalog; and after rebuild-compaction a synthetic handoff plus a recent player-facing transcript tail. Distinct from Memory Hygiene and from stock harness compaction.
_Avoid_: RAG pipeline, prompt builder (implementation), stuffing

**Rebuild-compaction**:
NQ-owned context pressure relief: run heavy Memory Hygiene on the play session, replace the play OMP session with a fresh one, re-pin from disk, and keep recent player-facing transcript Turns up to the Hygiene interval. Not OMP stock compaction and not durable memory by itself.
_Avoid_: snapcompact, harness compact (alone), promote-before-evict

**Memory Hygiene**:
An internal maintenance pass that alone updates Campaign memory files: light passes catch up facts after N successful Turns, and heavy passes also organize memory before rebuild-compaction. Its maintenance conversation is separate from player-facing play history.
_Avoid_: cleanup job, vacuum, remember tool, compaction (rebuild-compaction is different)

**Provider**:
The inference backend selected for Game Master play on **Home** (Grok, Claude, ChatGPT, this computer, plus More…). Reached through the embedded OMP model stack rather than a NQ-owned chat port. The player sees display names only.
_Avoid_: model, LLM, backend (alone); OMP, auth-broker, selector ids (player-facing)
