# Campaign folder is the memory contract

Neverending Quest stores all durable play memory as a **prescribed Campaign folder** of human-inspectable files. Campaign memory is the durable baseline for standing facts; successful player-facing transcript rows carry newer truth until Memory Hygiene catches the files up. The OMP session journal under `.nq/sessions/` is a private agent trace and loses to Campaign memory plus the successful transcript on conflict. There is no structured Side-channel schema, no vector-primary memory store, and no `episodic.jsonl` staging log.

**Why:** A fixed tree makes resume-by-path, sandbox path rules, Context pins, and Memory Hygiene targets implementable without reopening “what is a Campaign.” Markdown keeps testing and player inspection boring. Memory Hygiene alone writes **Story Beats**, **Quest Log**, **Twists**, **Player Sheet**, **World-Building**, and **Dossiers**. This removes memory bookkeeping and write-tool loops from player-facing Turns; the successful transcript bridges the deliberate lag between Hygiene passes.

## Prescribed tree (v1)

```
<campaign>/
  campaign.yaml          # NQ identity meta only
  seed.md                # Campaign premise and rules; GM never writes it, player may via Inspect
  player_sheet.md        # durable PC baseline; Hygiene-authored
  world-building.md      # factions / events / setting (not one person/place)
  dossiers/<slug>.md     # recurring person | place | other
  story-beats.md         # Ultra past chronicle (Hygiene-authored)
  quest-log.md           # open actionable branches only (Hygiene-authored)
  twists.md              # unspent story turns the player has not seen coming (Hygiene-authored)
  transcript.jsonl       # player-facing prose SoT (NQ-owned appends)
  .nq/sessions/          # OMP SessionManager journal (private)
  .nq/play_state.json    # NQ Play Loop / hygiene bookkeeping (NQ-only writes)
```

Resume-by-path requires readable `campaign.yaml` (`id`, `created_at`, `schema_version`, `name`). Model/provider profile is **not** Campaign meta — it lives in user config.

## File roles (binding)

| Path | Role |
| --- | --- |
| `player_sheet.md` | Privileged singleton, **not** a Dossier. Required H2s by convention: Description, Inventory, Powers, Notes. Entire file always hard-pinned. Powers and PC inventory live here; recent successful dialogue may be newer until Hygiene catches it up. |
| `world-building.md` | Factions, ongoing events, monster ecology, broad setting facts. Graduate to a Dossier only when a recurring person or place emerges. |
| `dossiers/<slug>.md` | Durable id = filename slug `[a-z0-9-]+`. Live path `dossiers/<slug>.md`; archived `dossiers/archive/<slug>.md` — that move is the only allowed path change. Never delete; never two files with the same slug. Required FM: `name`, `aliases`, `kind` (`person`\|`place`\|`other`); person FM keeps `regard`, `personality`, and `appearance`; non-person FM may keep `appearance`; merge stubs use `stub_of`. Body permits only optional `Inventory` (people), `Relationships`, `Abilities`, `Quirks`, and `Establishment` (places) H2s. New leaves scaffold every applicable heading empty. Chronology, encounters, recent actions, and event history go to Story Beats. Create when an entity will recur; use `edit` for every existing leaf and `write` only to create a leaf. Merge → keeper + thin stub. Catalog pin is live dossiers only; search still finds archived. |
| `story-beats.md` | Chronicle of past events, one compact factual line per beat. **Memory Hygiene** alone appends. v1 append-only (no cold rewrite of ancient lines). Full file always pinned. |
| `quest-log.md` | Open bullets only; Hygiene adds and **deletes** when done — no Resolved graveyard. |
| `twists.md` | The only **forward-looking** memory file: 3–6 unspent one-line twists, each grown from a live person, quest, or beat and naming what would reveal it. Full file always pinned so the GM can steer toward one, but read-only during a Turn and never stated in prose — a twist is possibility, not canon, until play makes it happen. Hygiene deletes a twist once it lands (the outcome becomes a Story Beat) or once the story makes it impossible. Player-visible on every surface; the web leaf is spoiler-veiled until the player clicks through. |
| `transcript.jsonl` | Rows `{ts, role: player\|gm, text}`. Player row on input accept; GM row on Turn SUCCESS only. No tool traces. |
| `seed.md` | Campaign premise and rules, included under `# The Scenario` after global voice and optional personality. Not merged into sheet for PC facts after birth. |
| `campaign.yaml` / `.nq/**` / transcript writes | **NQ-owned**; GM tools must not write. |

Throwaway color stays transcript-only. New standing truth remains in successful transcript rows until Memory Hygiene writes it to the right Campaign file.

Memory-format instructions belong only to Memory Hygiene, not the shared Game Master prompt or pinned file headers. Event history goes only in Story Beats; Dossiers contain current, durable subject facts, never scene summaries or one-off reactions. A lasting trait or relationship requires an explicit commitment, a lasting change, or recurring evidence. Maintenance instructions, tool traffic, and summaries are excluded from subsequent play history while their memory-file changes persist. Transcript prose remains fully written for the player.

## Sandbox path policy (layout-level)

`cwd` = Campaign absolute path. Nothing outside the folder. During play, GM tools are read-only plus `roll`; Memory Hygiene receives write tools for prescribed Campaign memory files. `transcript.jsonl`, `campaign.yaml`, `.nq/**`, and `illustrations/**` stay denied to GM tools.

## Considered options

- **Freeform wiki + bash** — rejected; pin guarantees and sandbox collapse.
- **SQLite / structured entity DB as primary SoT** — rejected for v1; human-inspectable markdown preferred for POC and testing.
- **Episodic jsonl + graduate-to-dossier** — rejected; authorship never stayed honest. Successful transcript rows bridge the interval until Hygiene writes sheet, world, dossiers, beats, and quests.
- **Player Sheet as `dossiers/player` or multi-file projection** — rejected; privileged singleton path and whole-file pin are simpler and match “PC is special.”
- **Powers as dossiers** — rejected; declared powers become current truth immediately and Hygiene records them on the sheet.
- **Twists inside `quest-log.md` or `world-building.md`** — rejected; open leads are things the player may act on and the world file is standing setting truth, while a twist is concealed and unspent. Mixing them invited the GM to narrate a twist as an available lead.
- **Twists hidden from the player surfaces** — rejected; the Campaign folder is inspectable by design and a hidden file would be the only exception. The web leaf blurs until clicked instead, so reading ahead stays deliberate.

## Consequences

- Implementers must not reopen prescribed paths, dossier slug identity, sheet H2 contract, beats/quests replacing episodic, or NQ-only ownership of transcript / `campaign.yaml` / `.nq/**`.
- Context Assembly pins and Memory Hygiene rewrite targets are defined over this tree ([docs/spec.md](../spec.md)).
- ADR-0002’s embedded agent reads these files during play and edits them during Memory Hygiene; the package cut does not change the memory contract.
