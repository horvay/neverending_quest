# Play authoring is surface-owned over Campaign git history

Players may edit the transcript, expand per-Turn **Scratch**, write Inspect, fire Memory Hygiene and rebuild-compaction by hand, and **Rewind** the Campaign folder to a past SUCCESS snapshot. Authoring is **surface-owned** (like Home). The Play Kernel stays `submit` / `interrupt`. History is **isomorphic-git** in-process (MIT, Bun `node:fs`) — players do not install or run `git`.

**Why:** Live-through play with a read-only story is honest until the player needs to fix a line, peek at what the Game Master did, or take the world back to an earlier beat. Those are Campaign-folder operations, not a second Game Master and not an OMP journal rewind. `AgentSession.branch` moves conversation only; the files would lie. A local git working tree is the snapshot primitive; Continue on a GM row is Rewind plus a hidden Turn that **extends that same row**.

## Considered options

- **Transcript-only chop** — rejected; sheet, world, dossiers, beats, and quests would stay “now.”
- **Require the `git` CLI** — rejected; players do not have git. isomorphic-git has no `reset --hard`; Rewind is `writeRef` + `checkout({ force: true })`.
- **LightningFS / in-memory git** — rejected; the Campaign is a real directory.
- **Resume the restored OMP journal** (`continueRecent` / `switchSession`) — rejected; Campaign files win, and a restored journal fights the tree. Ignore `.nq/sessions/`. After Rewind: session replace + re-prime.
- **Detached checkout / forward ref / second timeline** — rejected; the branch tip moves. The history list only shows what’s still reachable. No undo-Continue.
- **Regenerate the GM reply from scratch** — rejected; Continue keeps the edited prefix.
- **Put authoring in the Play Kernel** — rejected; kernel stays the story fold. Surfaces request; the Play Loop (and a Campaign git helper) execute.
- **TUI memory editor** — rejected at first; reopened by [ADR-0011](0011-player-surfaces-at-parity.md), and the terminal now inks Inspect too. `nq show` stays read-only.
- **`$EDITOR` for TUI Edit** — rejected; overlay in-process.

## Consequences

- Spec §2 / §5 / §14: player Edit, Continue, Inspect Save, and git Rewind are in scope. **No regenerate.** FAIL commits the accepted player row (`fail`); Delete of that tail Rewinds the `fail` commit. No automatic undo on cancel. No Campaign lock file (last writer wins).
- Spec §4: track memory files, `transcript.jsonl`, `.nq/scratch.jsonl`, `.nq/play_state.json`, `campaign.yaml`, `seed.md`, `.gitignore`. Ignore `.nq/sessions/` and `illustrations/` (PNG files; the transcript stamp is tracked — [ADR-0007](0007-illustration.md)). Campaign folder is a local git working tree (`main`).
- Spec §5 / §10: commit after birth, opening-message copy, SUCCESS busy window (automatic hygiene folded in), FAIL (`fail`), Edit / Inspect Save / manual hygiene / Illustration stamp (`illustrate`). Delete of a finished Turn or a `fail` tail Rewinds (no extra commit). Continue = confirm → Rewind if not HEAD → reload from disk → re-prime → hidden GM Turn extends that row (no player `(continue)` line).
- Spec §7–8: automatic schedule unchanged. Manual Light / Heavy / Compact / Fresh live on Inspect Status (web) and `/light` `/heavy` `/compact` `/fresh` (TUI).
- ADR-0002 / 0003 unchanged (hybrid embed; prescribed paths). ADR-0004 kernel commands unchanged. ADR-0005 Home **Continue** (open a Campaign) is a different word-sense from the GM-row button.
- Implementation is a later map (`.scratch/nq-authoring-poc/`), not this ADR.

Normative detail lives in [`docs/spec.md`](../spec.md). Grill: [`.scratch/nq-play-authoring/`](../../.scratch/nq-play-authoring/map.md). Research: [`docs/research/campaign-git-history.md`](../research/campaign-git-history.md), [`docs/research/omp-session-branch.md`](../research/omp-session-branch.md).
