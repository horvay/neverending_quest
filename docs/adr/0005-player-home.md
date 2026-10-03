# Player Home is a pre-play sibling of play chrome

Both Player Surfaces open a **Home** screen when no Campaign is selected: sign in (Provider + Model), Continue (Campaigns by name), New adventure (Seed Packs in `packs/`). Once a Campaign is open, Provider/Model are fixed for that process and play chrome is unchanged. Leave from play returns to Home and tears down the Play Loop. One Campaign at a time; `play` / `serve` / `turn` still never share a process.

**Why:** Resume-by-path and `nq login` are a tool interface. A player should not see OMP, model ids, or folders. The missing piece was a lifecycle surface, not more widgets on the book or the TUI story. Sign-in is `AuthStorage.login` in-process (same vault as play), not a NQ-owned auth port and not OMP’s coding-agent TUI.

## Considered options

- **Pickers inside play chrome** — rejected; reopens story-only TUI and the book (issues 07 / 08).
- **Keep `nq login` + path as the player path** — rejected; leaks the harness.
- **Full OMP `/login` widgets** — rejected (ADR-0002 / 0004); reuse the callback API only.
- **Curated pack allowlist file** — rejected; `packs/` is the list. Eval fixtures do not live there. Private packs stay local (gitignored).
- **Spawn the local model when Home opens** — rejected; opening `nq play` / `nq serve` must not claim the GPU. **This computer** discovers GGUF files from `models/` and from directories already referenced by the runtime installation record; adding or removing a file updates the picker without registration. Choosing it opens a focused local setup modal; confirming the model, context window, reasoning-token budget, and thinking level activates Atomic through the per-user Local Inference Host. Opening a Campaign with that saved selection is the equivalent activation.

## Consequences

- Spec §10: bare `nq play` / `nq serve` open Home; a path still skips Home.
- Spec §11: New adventure scans `packs/`; default Campaign dir is XDG data.
- Spec §14 “Multi-Campaign management UX beyond resume-by-path” is resolved for v1 Home.
- ADR-0003 unchanged: model/provider stay in user config, not `campaign.yaml`.
- The Local Inference Host owns Atomic and `sd-cli`, exposes the stable llama.cpp endpoint, serializes GPU use, and restores the selected model/context/reasoning profile after Illustration success, failure, or cancellation.
- Remote model selection leaves Atomic stopped. A remote Game Master may still request local Illustration without loading Atomic.
- ADR-0004 unchanged for play chrome, kernel commands, bind, and Inspect.
- Surfaces issue 07 / 12 “no multi-Campaign picker” applies to **play**, not Home.

Normative detail lives in [`docs/spec.md`](../spec.md). Grill: [Player Home](../../.scratch/nq-player-surfaces/issues/15-player-home-provider-and-packs.md).
