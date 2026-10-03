# Dual Player Surfaces over a Play Kernel

Neverending Quest owns **two** Player Surfaces for one Play Loop: OpenTUI `nq play` and a localhost Bun page `nq serve`. Both fold the same **Play Kernel**. Effect wraps `PlayLoop` only in the new surface layer. The web page is **Preact**; Effect does not run in the browser.

**Why:** The v1 engine spec left web out of scope and the TUI library as latitude. Playable long-horizon Campaigns need a real play chrome (live `prose_delta`, hard-busy) and a place to *read* Campaign memory without putting a wiki in the terminal. Two thin surfaces over one kernel beat a second Play Loop. Effect pays for Scope, streams, and HTTP cancel on the server; OpenTUI has no Effect interop, so the kernel stays pure. Preact is the smallest view library that can hold the book spread without a React/Vite stack.

## Considered options

- **Readline-only `nq play`** — rejected; it never streamed draft and is not a TUI.
- **`pi-tui` / full `omp` as the player client** — rejected (ADR-0002); coding-agent chrome leaks.
- **Effect in the browser** — rejected; a second runtime beside OpenTUI.
- **Vanilla DOM only** — rejected after chrome grilling; book + inspect + multi-line composer is enough view work for Preact. React / Vue / Solid / Lit still out.
- **LAN / hosted web** — rejected; no auth. Bind `127.0.0.1` only.
- **Inspect inside the Play Kernel / TUI** — rejected; `showCampaign` is a serve-only sibling.

## Consequences

- Spec §2 no longer lists “Web UI / browser client” as a non-goal (mobile stays out).
- Spec §10 is CLI + Player Surfaces, not “TUI widget latitude.”
- ADR-0002’s hybrid embed is unchanged. Play Loop stays Promise-based.
- Implementation is a later execution map (`.scratch/nq-surfaces-poc/`), not this ADR.

Normative detail (routes, flags, test layers, book IA) lives in [`docs/spec.md`](../spec.md). Grill history: [`.scratch/nq-player-surfaces/`](../../.scratch/nq-player-surfaces/map.md).
