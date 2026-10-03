# NQ is a hybrid OMP agent over a Campaign folder

Neverending Quest does **not** own a custom Chat Completions Turn loop with a structured Side-channel JSON/tool payload beside prose. Play is an **NQ-owned loop and UI** wrapped around an **OMP-shaped agent stack** whose working directory is the **Campaign folder**. During play, the Game Master reads Campaign memory through sandboxed `read` / `search` / `search_full` and resolves uncertainty through `roll`. Hidden Memory Hygiene prompts temporarily receive `edit` / `write` / `archive` and own every Campaign-memory write. One prompt may produce multiple inner tool rounds; the final assistant prose is the only player-visible Turn reply.

**Why:** The “Side-channel beside chat” design duplicated what an agent harness already does (multi-step tool use against a project tree). A Campaign-as-folder model makes memory human-inspectable, simplifies persistence, and reuses OMP’s model registry, streaming, tools, sessions, and compaction instead of re-specifying a Provider port and wire encoding.

**Package cut (resolved):** embed **`@oh-my-pi/pi-coding-agent@17.0.9`** (pin exact; `pi-ai` / `pi-agent-core` / `snapcompact` transitive) via `createAgentSession` with `cwd` = Campaign abs path, registered built-in and NQ custom tools, `restrictToolNames: false`, play active tools `read` / `roll` / `search` / `search_full`, prompt-scoped Hygiene tools `read` / `edit` / `write` / `search` / `search_full` / `archive`, and `memory.backend: "off"`. NQ owns Player Surfaces and CLI (no direct `pi-tui` / `pi-mnemopi` / `snapcompact` dependency; surfaces → [ADR-0004](0004-dual-player-surfaces.md)). OMP JSONL under `.nq/sessions/` is the private agent journal; Campaign `transcript.jsonl` is the player-facing prose source of truth. Path jail is not built-in; NQ adds a `tool_call` guard. Details: [OMP package cut and embed](../../.scratch/neverending-quest/issues/16-omp-package-cut-and-embed.md).

## Considered options

- **Custom Provider + Side-channel (ADR-0001 path)** — rejected for v1 product shape after pivot; too much bespoke wire/assembly for the same “model edits structured state” outcome.
- **Full `omp` CLI as the player surface** — rejected; NQ owns play UX (story-only), command set, and Campaign lifecycle.
- **Folder-backed memory with a single-shot chat Side-channel** — rejected; underuses multi-step file tools the harness provides.
- **Freeform wiki with bash** — rejected for v1; required memory files + no bash keeps sandbox and pin guarantees.

## Consequences

- ADR-0001 (Chat Completions Provider port) is **superseded** for the product architecture. Grok/Bonsai research still constrains **model choice and capability expectations**, not a NQ-owned port.
- Glossary term **Side-channel** is retired for the runtime path; memory authorship is **file tools in the Campaign folder**.
- **Context Assembly** becomes policy for what the agent session is primed with and how compaction relates to on-disk Campaign files — not a pure “stuff messages for one completion” function alone.
- TUI/CLI must subscribe to agent events and surface **prose only** by default.
- Spec destination is [`docs/spec.md`](../spec.md) plus ADRs; memory tree detail is [ADR-0003](0003-campaign-folder-memory-contract.md).
