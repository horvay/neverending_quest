# Hosted play runs in the browser behind a ciphertext relay

Status: **accepted** 2026-09-25 (ads and content policy open — see [`.scratch/nq-hosted-browser/map.md`](../../.scratch/nq-hosted-browser/map.md))

A hosted Player Surface runs the whole Play Loop in the player's browser. The Campaign folder lives in the browser's origin-private file system (OPFS) with isomorphic-git history. Nothing about a Campaign is stored server-side. The only backend is a stateless relay on Cloudflare (static assets plus one Worker) that holds the Runpod key and forwards sealed bytes to the existing `nq-qwen27b` load-balancer endpoint. The browser speaks the seal protocol itself (WebCrypto X25519 / Ed25519 / HKDF / AES-GCM), so the relay never sees plaintext.

**Why:** Cheapest possible hosting with the same privacy the local seal proxy gives. Static assets and a Worker that only pipes a stream fit Cloudflare's free plan (100k requests/day, no wall-clock limit while connected, 10 ms CPU unused by pass-through streaming). Spend stays GPU-seconds only.

**Shape (built 2026-09-25):** the page runs the same Home surface, Play Loop and HTTP routes as `nq serve`, as an in-page web handler (`src/surfaces/hosted/app.ts`) that the unchanged book's `fetch("/api/…")` calls reach. The browser bundle (`src/surfaces/hosted/build.ts`) swaps `node:fs` for an OPFS-backed tree and stubs OMP imports, so no Campaign or play code forks. Only the Game Master differs: `src/agent/browser/agent.ts` implements `AgentSessionFactory` with a streaming chat-completions tool loop, over the WebCrypto seal client (`packages/seal/src/browser.ts`) and the relay Worker (`src/surfaces/hosted/relay.ts`). Its `read` / `edit` / `write` are plain read and exact-string replace instead of OMP's hashline patches.

## Considered options

- **Lakebed.dev** — rejected. Every handler stops at 5 s and nothing streams, but the load-balancer endpoint holds one request through cold boot (~2 min) and generation. A queue endpoint would need a rebuilt worker and polling that burns the 1,000-per-day mutation quota (~20–30 Turns/day). No npm imports, no CSS files, favicon-only static assets, 1 MiB artifact. Public alpha.
- **Static site with the Runpod key in the browser** — viable for one trusted player only (Runpod allows `*` CORS; the seal worker would need CORS). Rejected as the default: a leaked key spends the balance.
- **Server-side Play Loop (current `nq serve` on a VPS)** — rejected; always-on cost and Campaigns stored off the player's machine.
- **Keep OMP in the browser** — impossible; `pi-coding-agent` needs `Bun.*`, `bun:sqlite`, and a native addon.

## Consequences

- **ADR-0002 stands for local play.** NQ keeps running locally on OMP. Only the hosted surface uses a separate NQ-owned browser agent (streaming chat completions + `read` / `edit` / `write` / `roll` / `search` / `search_full` / `archive`), plugged into the Play Loop's agent-factory seam.
- **ADR-0006:** "LightningFS / in-memory git — rejected; the Campaign is a real directory" is reopened for the hosted surface only. There the Campaign is an OPFS directory; isomorphic-git runs over an OPFS `fs` adapter.
- **ADR-0005:** hosted Home has one Provider (the relay). OMP sign-in Providers and "this computer" are absent.
- **ADR-0007:** hosted Illustration is out of scope until a second GPU route is justified on cost.
- `.nq/sessions/` does not exist in the hosted build; hidden-prompt rollback is an in-memory message array.
- Players must be able to export and import a Campaign (zip), and the app requests persistent storage, because browsers may evict site data.
- The hosted surface is public and ad-funded. The relay is a spend surface. v1 relies on keeping the Runpod balance small; a bot check, per-visitor cap, and global daily budget come later. It starts on a free `*.workers.dev` address.
- Tests: deep only. Fakes sit at llama-server behind the real seal worker; everything NQ owns (browser Play Loop, agent loop, seal client, relay, OPFS, git) runs for real. Browser tests run inside `bun test` (no second runner, per [mocked UI test stacks](../research/mocked-ui-test-stacks.md)).
