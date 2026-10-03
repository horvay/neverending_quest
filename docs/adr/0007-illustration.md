# Illustration is a local picture, not Campaign git history

The player may request an **Illustration** of the latest Game Master row. The picture file lives in the Campaign folder (`illustrations/<id>.png`) and the id is stamped on that transcript row. The PNG is gitignored. The stamp commits (`illustrate`). Rewind restores which row had a picture; a missing file simply does not show.

**Why:** Campaign git is the snapshot primitive for memory and prose. Weights-sized PNGs would bloat every SUCCESS. The id is enough to join a local file to a row. The Game Master never sees or writes Illustrations. Not Inspect. Not a Campaign Sandbox tool.

## Considered options

- **Commit the PNG** — rejected; local, replaceable, large.
- **Keep the file under `.nq/`** — rejected; the player asked for the Campaign folder, and Inspect already excludes `.nq/**`.
- **No transcript stamp** — rejected; Rewind is `checkout --force` and would wipe an uncommitted link.
- **Game Master `illustrate` tool** — rejected; player-only, Idle, explicit click.
- **Inspect Status button** — rejected; Inspect is Campaign memory. The control is desk chrome (brush above the inkwell) on `nq serve`.

## Consequences

- Campaign `.gitignore` ignores `illustrations/` as well as `.nq/sessions/` (amends [ADR-0006](0006-play-authoring.md)).
- Transcript rows may carry optional `illustration` (the GM row `ts`) and `illustrationPrompt` (the Anima prompt used to paint it). Edit still changes `text` only.
- Prompt rewrite is a read-only lookup pass (not a play Turn): pinned player sheet + live dossier catalog (`appearance` in FM). `read` / `search` / `search_full` only when a catalog appearance is blank. It must not write. Isolated from the live Game Master session. Scratch from that pass streams onto the easel. Then local `sd-cli` paints four seed variants; the player picks one. The stamp commits (`illustrate`) only after that pick. `sd-cli` + Anima Turbo Q8, Qwen 0.6B encoder, and Qwen Image VAE live in XDG `~/.local/share/nq/anima/` until packaging is decided. No weights in the nq git repo.
