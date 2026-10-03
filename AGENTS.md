## Agent skills

### Issue tracker

Issues live as local markdown under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Layout and checks

The source is layered; imports only point down the stack (ADR-0010): `packages/*` → `src/campaign` → `src/play` (game core) → `src/config.ts` → `src/agent`, `src/home` → `src/surfaces/{tui,web,hosted}` → `src/cli.ts` and `src/cli/`. Put new code in the lowest layer that can own it. A player feature belongs in the Play Loop or Home and is reached by both Player Surfaces through `PlaySessionApi` / `HomeSurface`; the web book calls it through the typed contract in `src/surfaces/web/api.ts`.

- `bun run typecheck` — TypeScript over this repo (OMP's shipped sources are skipped) plus the layer check (`scripts/check_layers.ts`).
- `bun run test` — the suite, with the per-test ceiling Bun's config file cannot set.

## Testing

Write deep tests. Each test should drive as many real layers at once as it can, for example the web book → HTTP routes → Play Loop → OMP adapter → Campaign tools → Campaign folder on disk and its git history. CLI tests call the real CLI `main` in-process (`tests/helpers/cli.ts`).

Never write small function-level unit tests, and never stub or mock code this project owns (our modules, HomeSurface, our HTTP routes, runtime managers, token estimators, and so on) to isolate one piece. If a behaviour matters, test it through the layers a player or the CLI would reach it by.

Every test must fake the connections to systems we don't control, and nothing else:

- the AI model behind the Game Master: use `scriptedGameMaster` (`tests/helpers/game_master.ts`), which puts a scripted model behind the real OMP adapter;
- the llama.cpp / Atomic engine process: a fake engine server or fake spawn;
- image generation: an injected generate hook or a fake `sd-cli`;
- remote network: Hugging Face, GitHub, Runpod, provider sign-in and model catalogs.

No test may call a real AI model, image generator, local engine, or remote service. The test preload (`tests/preload_native.ts`) gives every run a throwaway `HOME` and XDG directories, so tests can never read the real config, auth store, or a live local inference host.

Keep the suite fast through cheap real work, not mocks: copy templated Campaign folders, wait on real state instead of sleeping, and run the CLI in-process.

Don't run the test suite for prose-only prompt edits, such as the Game Master voice (`src/play/gm_voice.md`), a Seed, or other model-facing text. The suite fakes the model, so it can't show whether a prompt change helps. Run it when code changes.
