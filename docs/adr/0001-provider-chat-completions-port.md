# Provider is one Chat Completions–shaped port

> **Superseded by [ADR-0002](0002-hybrid-omp-agent-campaign-folder.md).**  
> The product no longer centers a NQ-owned Provider port and Side-channel wire. Grok / Bonsai / long-horizon research captured under tickets 01–03 remains valid as **model and memory-pattern constraints** for whatever OMP stack NQ embeds.

The Turn loop and Context Assembly talk to a single **Provider** port shaped like OpenAI Chat Completions (assembled messages in; stream events + final TurnResult out). Grok may use Responses under the hood and normalize; local llama-server and other OpenAI-compatible backends hit `/v1/chat/completions` directly. Callers never branch on wire dialect.

**Why this shape:** Grok research prefers Responses; Bonsai research is Chat Completions–only on llama-server. A dual domain port or fat multi-port split would leak adapter concerns into the Turn loop. One normalized port keeps Context Assembly and Side-channel honest about the Grok∩Bonsai intersection.

**Every Provider must:** stream assistant tokens; honor/report context and max-output caps; accept full client-assembled messages (**stateless** — no server conversation store / `previous_response_id`); offer structured Side-channel via **at least one of** tools or JSON schema/`response_format`, advertised by capability flags (neither mode alone is mandatory).

**Every Provider must not be assumed to:** support both structure modes; expose Grok-only server state; run live web/X search; or match cloud-scale context on local hardware.

**Caps:** each backend has a static profile (`provider_ctx`, `max_output`, `supports_tools`, `supports_json_schema`, reasoning defaults) with optional live probe to fill local numbers. **Effective assembly budget** = `min(provider_ctx, effective_ctx_budget)` where `effective_ctx_budget` defaults to **128k** and is configurable — an anti-context-rot ceiling, not “use the whole model window.”

**Normalized completion:** stream prose deltas (optional reasoning deltas, hidden by default); side-channel payload when complete; final `TurnResult` with prose, side_channel (parsed or raw+mode), usage (including reasoning tokens when present), `finish_reason`, caps used.

**v1 adapters:** Grok + generic OpenAI-compat (`base_url` / key / model). Bonsai is a config profile on the generic adapter, not a third port.

**Outside the port:** Context Assembly, Side-channel validate/apply, Campaign I/O, live search, multi-agent orchestration.

## Considered options

- Dual wire adapters behind a domain-only port — rejected as extra indirection for the same normalized events.
- Fat multi-port (auth / stream / tools / schema separate) — rejected; Turn loop would re-compose a chat port ad hoc.
- Stream-text-only port — rejected; memory apply needs a structured path with capability negotiation.
- Stateful Grok sessions (`previous_response_id`) — rejected; Campaign disk is sole truth.

## Consequences

- Side-channel wire format must work through capability flags (tools and/or schema), not Grok tools alone.
- Context Assembly always sizes to the effective budget, never raw model maxima.
- TUI streams via port events; it does not parse vendor chunk shapes.
