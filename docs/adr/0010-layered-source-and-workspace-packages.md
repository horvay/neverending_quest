# Layered source tree and workspace packages

Status: **accepted** 2026-10-01

The source is layered, and imports only point down the stack. `bun run typecheck` fails when one points up (`scripts/check_layers.ts`).

| Layer | Path | May import |
| --- | --- | --- |
| Packages | `packages/seal`, `packages/local-inference` | nothing from `src/` |
| Campaign | `src/campaign` | — |
| Game core | `src/play` | campaign |
| Config | `src/config.ts` | play, campaign |
| Game Masters | `src/agent/{omp,browser}`, dev fakes `src/dev` | config, play, campaign |
| Home | `src/home` | config, play, campaign |
| Player Surfaces | `src/surfaces/{web,tui,hosted}` | home, config, play, campaign, agent |
| Composition root | `src/cli.ts` | everything |

Packages and the shared root modules (`model_selector.ts`, `toml_lite.ts`) may be imported from any layer.

**Why:** The app had grown to three products in one folder layout: the game, a local model manager (two engines, an Almanac, a GPU handoff to the painter), and three front ends (terminal, local web, hosted browser). `src/play` held the Play Loop and every front end, so `play`, `home`, `agent` and `local` imported each other. Nothing stopped the next import going the wrong way.

## Decisions

- **Bun workspaces for code that is general or runs in more than one place.** `@nq/seal` is the sealed transport: one wire definition (`wire.ts`) for the loopback proxy, the Runpod worker and the browser client. `@nq/local-inference` is engines, the Local Inference Host, the catalog, the Almanac and the sd-cli painter. The game itself stays the root app; splitting `campaign` / `play` / surfaces into packages would add `exports` plumbing for no gain the layer check doesn't already give.
- **The game core declares ports; adapters implement them.** `AgentSessionFactory` (OMP locally, the browser agent hosted, a scripted model in tests) and `Illustrator` (the Local Inference Host's painter, `localPainter` in-process, the dev swatch painter). The Game Master's domain tools (`roll`, `search`, `search_full`, `archive`) are defined once in `src/play/gm_tools.ts`; each adapter wraps them in its own tool format.
- **The book has a typed HTTP contract.** `src/surfaces/web/api.ts` names every route and its request and response types. Both `nq serve` and the hosted in-page handler answer it, and the client calls it through one typed client.
- **Dev fakes are a composition choice.** `NQ_FAKE_AGENT=1` swaps in the fake Game Master and swatch painter in one place (`src/dev/fake_table.ts`). Tests never use them; they inject `scriptedGameMaster` behind the real adapter.

## Considered options

- **One package per layer** — rejected for now: TypeScript project references and per-package `exports` for code with one consumer. The layer check enforces the same direction.
- **Move local inference to its own repository** — rejected: the Game Master's "Answer now", thinking prefill and the GPU handoff to the painter still change together with play. The package boundary keeps it separable.
- **Isolated `node_modules` linker** — rejected: OMP and the postinstall patches expect one hoisted tree (`bunfig.toml` `[install] linker = "hoisted"`).
