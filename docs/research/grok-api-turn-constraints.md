# Grok API turn constraints

Research note for ticket [Grok API turn constraints](../../.scratch/neverending-quest/issues/01-grok-api-turn-constraints.md).  
Primary sources: xAI docs (`docs.x.ai`) as of 2026-08-05. No public OpenAPI JSON was served at `api.x.ai/openapi.json` / `swagger.json` (404); field-level truth is the REST reference under `/developers/rest-api-reference/`.

## Summary (Provider + Side-channel implications)

| Constraint | Fact | Side-channel impact |
| --- | --- | --- |
| Auth | Bearer API key on `https://api.x.ai/v1` | Store `XAI_API_KEY`; no OAuth required for API path |
| Preferred chat surface | **Responses API** `POST /v1/responses`; Chat Completions is **legacy** | Provider should target Responses, keep Chat Completions optional for OpenAI-SDK ergonomics |
| Context | Model-dependent: **500k** (`grok-4.5`), **1M** (`grok-4.3` / 4.20\*), **256k** (`grok-build-0.1`) | Context Assembly budget is generous; pin order still matters for cost/latency, not hard fit |
| Default max generation | **128,000** tokens if unset (`max_completion_tokens` / `max_output_tokens`) | Cap GM turns well below default for cost; reasoning tokens share/compete with visible output on Responses |
| Streaming | SSE; all text models | TUI can stream prose; tool-call payloads arrive as **one whole chunk**, not token-streamed |
| Structured JSON | `response_format` / `text.format` = `json_schema` (guaranteed) or `json_object` | Full-message schema ⇒ entire assistant content is JSON — put player prose **inside** a schema field, or use a **tool call** for ops while content stays prose |
| Tools | ≤128 tools; args schema-strict; parallel default | Viable Side-channel encoding without polluting player text |
| Rate limits | Per-model **RPS + TPM**, tiered by spend; `429` | Single-player GM loop is far under Tier 0 caps |

---

## 1. Auth and base URL

- Base URL: `https://api.x.ai/v1` ([quickstart](https://docs.x.ai/developers/quickstart), [inference overview](https://docs.x.ai/developers/rest-api-reference/inference)).
- Auth header on all routes: `Authorization: Bearer <your xAI API key>` ([inference overview](https://docs.x.ai/developers/rest-api-reference/inference)).
- Keys created in console: [API Keys](https://console.x.ai/team/default/api-keys); env var convention `XAI_API_KEY` ([quickstart](https://docs.x.ai/developers/quickstart)).
- OpenAI SDK works with `base_url="https://api.x.ai/v1"` and the same key ([quickstart](https://docs.x.ai/developers/quickstart)).
- Official Python path also includes `xai-sdk` (gRPC under the hood) covering chat + management ([generate text](https://docs.x.ai/developers/model-capabilities/text/generate-text)).

**Not required for v1 Provider:** console OAuth / device-code flows used by the Grok Build CLI.

---

## 2. Request / response shapes

### 2.1 Responses API (preferred)

- Endpoint: `POST /v1/responses` ([REST chat ref](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-responses), [generate text](https://docs.x.ai/developers/model-capabilities/text/generate-text)).
- Docs call this the preferred interaction path; optional **server-side storage** of prior turns (default on; 30-day retention; `store: false` to disable) ([generate text](https://docs.x.ai/developers/model-capabilities/text/generate-text)).
- Continue with `previous_response_id` instead of resending full history ([generate text](https://docs.x.ai/developers/model-capabilities/text/generate-text)).
- Key request fields ([REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-responses)):
  - `model`, `input` (string or message array), optional `instructions` (system; **cannot** pair with `previous_response_id`)
  - `max_output_tokens` — max generated tokens **including reasoning**; default **128,000** when unset
  - `stream`, `tools`, `tool_choice`, `parallel_tool_calls`
  - `text.format` for structured output
  - `reasoning` / `reasoning_effort` (effort levels on `grok-4.3`: `none` \| `low` \| `medium` \| `high`)
  - `include: ["reasoning.encrypted_content"]` to get encrypted thinking for local replay when `store: false`
- Response: `object: "response"`, `output[]` items (`message`, `function_call`, …), `usage` with `input_tokens` / `output_tokens` / `output_tokens_details.reasoning_tokens` ([REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-responses)).

**Campaign persistence note:** Neverending Quest owns Campaign state on disk. Prefer **stateless** calls (`store: false` or always send full assembled context) so server 30-day history is not a hidden dependency. Stateful `previous_response_id` is optional optimization only.

### 2.2 Chat Completions (legacy, still supported)

- Endpoint: `POST /v1/chat/completions` ([REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-chat-completions), [legacy guide](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions)).
- Explicitly **legacy**: new features land on Responses first ([legacy guide](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions)).
- **Stateless**: client must resend full conversation each turn ([legacy guide](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions)).
- Key request fields ([REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-chat-completions)):
  - `model`, `messages[]` (`system` \| `user` \| `assistant` \| tool messages)
  - `max_completion_tokens` — upper bound on **visible** output tokens only (does **not** cap reasoning or function-call tokens); default **128,000**; `max_tokens` deprecated alias
  - `stream` / `stream_options.include_usage`
  - `response_format`, `tools` (max **128** functions), `tool_choice`, `parallel_tool_calls`
  - `temperature` (0–2), `top_p`, `stop` (not on reasoning models), `seed`, `user`
- Response: OpenAI-shaped `chat.completion` with `choices[].message.{role,content,tool_calls,reasoning_content,refusal}`, `usage.prompt_tokens` / `completion_tokens` / `completion_tokens_details.reasoning_tokens` ([REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-chat-completions)).
- **No role order limitation** on chat models: `system` / `user` / `assistant` may appear in any sequence ([models](https://docs.x.ai/developers/models)).

### 2.3 Message content forms

- Text-only: `content` as string, or as `[{ "type": "text", "text": "..." }]` ([legacy guide](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions)).
- Multimodal: `image_url` parts (jpg/png, ≤20 MiB, unlimited count) on image-capable models ([models](https://docs.x.ai/developers/models), [legacy guide](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions)).

---

## 3. Models, context windows, output caps

### 3.1 Text model IDs (current docs table)

From [Models](https://docs.x.ai/developers/models) and model pages:

| Model ID | Context | Function calling | Structured outputs | Reasoning | Notes |
| --- | ---: | --- | --- | --- | --- |
| `grok-4.5` | **500,000** | Yes | Yes | Yes | Recommended default; aliases `grok-4.5-latest`, `grok-build-latest` ([model page](https://docs.x.ai/developers/models/grok-4.5)) |
| `grok-4.3` | **1,000,000** | Yes | Yes | Yes | Aliases `grok-4.3-latest`, `grok-latest` ([model page](https://docs.x.ai/developers/models/grok-4.3)); `reasoning_effort` supported |
| `grok-4.20-0309-reasoning` | 1,000,000 | (family) | (family) | Yes | Pinned release id ([models](https://docs.x.ai/developers/models)) |
| `grok-4.20-0309-non-reasoning` | 1,000,000 | (family) | (family) | No | Pinned release id |
| `grok-build-0.1` | **256,000** | (listed) | (listed) | — | Coding-oriented |
| `grok-4.20-multi-agent-0309` | 1,000,000 | — | — | — | Multi-agent; tighter rate limits |

Alias rules ([models](https://docs.x.ai/developers/models)):

- `<name>` → latest stable  
- `<name>-latest` → latest (features move)  
- `<name>-<date>` → pinned, no silent upgrade  

Knowledge cutoff for Grok 4.5: **2026-02-01** ([models](https://docs.x.ai/developers/models)). No live world knowledge without search tools.

### 3.2 Output token defaults vs hard model max

- Chat Completions: `max_completion_tokens` defaults to **128,000**; applies only to **visible** completion tokens, not reasoning or function-call tokens ([REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-chat-completions)).
- Responses: `max_output_tokens` defaults to **128,000**; **includes output + reasoning** ([REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-responses)).
- Finish reasons include `length` when hitting model max or user `max_*` ([REST chat completions](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-chat-completions)).
- Practical budget: `prompt_tokens + completion(+reasoning) ≤ context_window`. Long-context **pricing** steps up at **200k prompt tokens** (higher $/M for the whole request) ([models](https://docs.x.ai/developers/models)).

Docs do **not** publish a separate per-model “max output” column beyond the 128k API default and the context window; treat 128k as the API default ceiling and context as the hard joint budget.

### 3.3 Usage accounting

- Chat: `prompt_tokens`, `completion_tokens`, `total_tokens`, plus `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` ([REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-chat-completions)).
- Responses: `input_tokens`, `output_tokens`, `total_tokens`, reasoning under `output_tokens_details` ([REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-responses)).
- Inference may add pre-defined tokens vs console tokenizer counts ([FAQ via rate-limits section linkage in llms index](https://docs.x.ai/developers/rate-limits)).

---

## 4. Streaming

- Supported for **all models with text output**; not for image-generation models ([streaming](https://docs.x.ai/developers/model-capabilities/text/streaming)).
- Enable with `"stream": true`; transport is **SSE**, terminated by `data: [DONE]` ([streaming](https://docs.x.ai/developers/model-capabilities/text/streaming), [REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-chat-completions)).
- Chat Completions chunks: `choices[0].delta.content` (OpenAI-compatible) ([streaming](https://docs.x.ai/developers/model-capabilities/text/streaming)).
- Reasoning models: raise client timeout (docs show 3600s) to avoid premature close ([streaming](https://docs.x.ai/developers/model-capabilities/text/streaming)).
- **Function calling + stream:** tool call is returned **in whole in a single chunk**, not streamed across chunks ([function calling](https://docs.x.ai/developers/tools/function-calling)).
- Structured outputs can stream as progressive JSON string chunks; parse only after the stream completes ([structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)).

---

## 5. Tools / function calling

- Define client tools with `name`, `description`, JSON Schema `parameters` ([function calling](https://docs.x.ai/developers/tools/function-calling)).
- Caps: Chat Completions **max 128 functions** ([REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-chat-completions)); Responses **max 128 tools** ([REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-responses)). (Tool-schema prose also says “max 200 tools per request” in one table row on the function-calling page — treat **128** from the REST reference as the hard API limit.)
- `parameters` root must be `object` (or `oneOf`/`anyOf` of objects); otherwise **400** ([function calling](https://docs.x.ai/developers/tools/function-calling)).
- Tool-call **arguments always strictly conform** to the tool schema (`strict` implicitly always true) ([structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)).
- Loop: model returns `tool_calls` / `function_call` → client executes → return `role: "tool"` (Chat Completions) or `function_call_output` (Responses) → model continues ([function calling](https://docs.x.ai/developers/tools/function-calling)).
- `tool_choice`: `auto` \| `required` \| `none` \| force named function ([function calling](https://docs.x.ai/developers/tools/function-calling)).
- `parallel_tool_calls: false` to force at most one call ([function calling](https://docs.x.ai/developers/tools/function-calling)).
- Built-in server tools (web search, X search, code execution, …) can mix with client functions; server tools run on xAI, client tools pause for local execution ([function calling](https://docs.x.ai/developers/tools/function-calling)). **GM v1 should not enable live search** unless product wants external world bleed.

---

## 6. JSON / structured outputs

Two mechanisms ([structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)):

1. **`response_format` / `text.format`**
   - `type: "json_schema"` + schema → **guaranteed** match when using supported keywords  
   - `type: "json_object"` → any well-formed JSON  
   - `type: "text"` → default free-form  
2. **Tool calling** — arguments schema-constrained as above.

JSON Schema support (practical subset; Draft 2020-12 best; Draft-07 accepted) ([structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)):

- Types: `string`, `number`, `integer`, `boolean`, `null`, `enum`, `const`, `array`, `object`, `anyOf`, `oneOf` (= anyOf), single-branch `allOf`, non-circular `$ref`/`$defs`
- `additionalProperties` defaults to **false** (must set `true` explicitly)
- Enforced formats: `date`, `time`, `date-time`, `email`, `uuid`, `ipv4`, `ipv6`, `uri`
- Constraint guarantees up to: `min/maxLength` 2048, `min/maxItems` 256, `min/maxProperties` 64
- Best-effort only: `not`, `if/then/else`, multi-`allOf`, exotic `format`s
- Rejected (400): empty enum/anyOf, boolean property schemas, `maxContains`/`minContains`, tuple `items` arrays
- `pattern`: ECMA-262 subset; always full-string match; no backrefs / lookaround / `\b`

Structured + tools together is supported on Grok 4 family ([structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)).

SDK helpers: `chat.parse(Model)`, OpenAI `beta.chat.completions.parse` / `responses.parse`, Zod `zodResponseFormat` ([structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)).

---

## 7. Rate limits

Source: [Rate limits](https://docs.x.ai/developers/rate-limits).

- Dimensions: **requests per second (RPS)** and **tokens per minute (TPM)**, **per model**, team-scoped (all keys on the team share budget).
- RPS is derived from per-minute request budget (burst protection).
- Tiers by cumulative API spend since 2026-01-01: T0 $0 → T1 $50 → T2 $250 → T3 $1k → T4 $5k → Enterprise. Tiers never downgrade.
- Exceed → HTTP **429**; docs recommend exponential backoff.

Tier 0 (default) examples:

| Model | RPS (T0) | TPM (T0) |
| --- | ---: | ---: |
| `grok-4.5` | 150 | 50,000,000 |
| `grok-4.3` | 37 | 10,000,000 |
| `grok-4.20-*` / `grok-build-0.1` | 37 | 10,000,000 |
| `grok-4.20-multi-agent-0309` | 9 | 2,500,000 |

TPM includes prompt + completion + reasoning + **cached** prompt tokens ([rate limits](https://docs.x.ai/developers/rate-limits)).  
Live team limits: [console rate limits](https://console.x.ai/team/default/rate-limits).

For a single-player Turn loop, Tier 0 is not the binding constraint; **cost and context quality** are.

---

## 8. Encoding a structured Side-channel beside player-facing prose

Standing product choice: same GM model, structured Side-channel (Dossier / Episodic ops), no separate writer pass.

API forces a **choice of wire pattern** — the model cannot emit unconstrained prose *and* a guaranteed parallel JSON document as two top-level channels in one Chat Completions `message.content` string without a convention:

### Pattern A — Single JSON object (schema-enforced)

```json
{
  "type": "json_schema",
  "json_schema": {
    "name": "gm_turn",
    "strict": true,
    "schema": {
      "type": "object",
      "properties": {
        "prose": { "type": "string", "description": "Player-facing narration only" },
        "side_channel": { /* ops array / dossier patches / episodic entries */ }
      },
      "required": ["prose", "side_channel"],
      "additionalProperties": false
    }
  }
}
```

- **Pros:** Guaranteed parse; one round-trip; works with streaming (buffer JSON, then split fields for TUI).
- **Cons:** Player never sees raw tokens as pure prose until parse; partial stream is JSON noise unless the TUI special-cases `prose` key incremental decode (non-trivial); entire payload counts as visible completion tokens.

### Pattern B — Prose in `content` + Side-channel via tool call(s)

- No `response_format` (or `text`).
- Expose one function e.g. `apply_memory_ops` with a strict ops schema.
- Model writes player prose to `message.content` and emits `tool_calls` for memory.
- **Pros:** Natural streaming of player text; tool args schema-guaranteed; matches “structured Side-channel” without stuffing JSON into the novel.
- **Cons:** May require a follow-up turn if the API stops on `tool_calls` before final prose (or vice versa)—design must accept **parallel** tool_calls + content in one assistant message when the model provides both; if the model only tool-calls, client may need `tool_choice: "auto"` and prompt pressure for always-on prose. Streaming: prose streams; tool JSON arrives as one chunk ([function calling](https://docs.x.ai/developers/tools/function-calling)).

### Pattern C — Delimited / fenced block in free text (not schema-enforced)

- Prompt-only convention (e.g. final ` ```json ` fence).
- **Pros:** Simple; streams as text.
- **Cons:** **No API guarantee**; fails open on malformed ops — conflicts with wanting reliable memory apply unless a repair pass exists (product currently avoids a second model pass).

### Pattern D — Two requests (writer split)

- Explicitly out of standing choices (“no separate writer pass”) unless research forced it — **not forced**. A/B are sufficient.

**Recommendation for design (not a product decision):** Prefer **B** if TUI streaming of clean prose is first-class; prefer **A** if apply-reliability and a single atomic Turn record matter more than raw token streaming. Hybrid: stream with B, and if `tool_calls` missing/malformed, optionally retry once with A. Provider interface should abstract the pattern so a later local Bonsai backend can implement the same Side-channel contract without xAI tools.

---

## 9. Other hard constraints affecting a Turn

| Topic | Constraint | Source |
| --- | --- | --- |
| Stop sequences | Up to 4; **not supported on reasoning models** | [REST chat](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-chat-completions) |
| `logprobs` | Ignored on `grok-4.20` and newer | [models](https://docs.x.ai/developers/models) |
| Frequency / presence penalty | Not on reasoning models (and presence not on grok-3) | [REST](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-chat-completions) |
| Server store TTL | 30 days then deleted | [generate text](https://docs.x.ai/developers/model-capabilities/text/generate-text) |
| Prompt cache | `prompt_cache_key` / sticky routing; cached tokens still use TPM | [REST](https://docs.x.ai/developers/rest-api-reference/inference/chat), [rate limits](https://docs.x.ai/developers/rate-limits) |
| Context compaction | `POST /v1/responses/compact` available | [REST](https://docs.x.ai/developers/rest-api-reference/inference/chat) |
| Deferred completions | `deferred: true` → poll deferred endpoint | [REST chat completions](https://docs.x.ai/developers/rest-api-reference/inference/chat#post-v1-chat-completions) |
| Anthropic-compat `/v1/messages` | **Deprecated** | [legacy](https://docs.x.ai/developers/rest-api-reference/inference/legacy) |
| Regions | e.g. `grok-4.5`: us-east-1, us-west-2 | [grok-4.5](https://docs.x.ai/developers/models/grok-4.5) |

---

## 10. Minimal Provider checklist for Neverending Quest

1. Auth: `Authorization: Bearer` + `base_url https://api.x.ai/v1`.
2. Default model id: `grok-4.5` (configurable; allow `grok-4.3` for 1M context / cheaper output).
3. Implement against **Responses** and/or **Chat Completions**; keep a thin Provider trait so Bonsai later is another adapter.
4. Always send **client-assembled** context (Dossiers + Player Sheet + recent messages); do not rely on `previous_response_id` for Campaign truth; set `store: false` if using Responses.
5. Set an explicit `max_completion_tokens` / `max_output_tokens` (far below 128k) sized for one Turn of prose + side data.
6. Stream for TUI; handle 429 with backoff; record `usage` including reasoning tokens for budget telemetry.
7. Pick Side-channel Pattern **A** or **B** in the wire-format ADR; do not depend on unguarded fenced JSON alone.
8. Disable server-side web/X search unless explicitly enabled — GM world is Campaign-local.

---

## Sources

- [Get started / overview](https://docs.x.ai/overview)
- [Quickstart](https://docs.x.ai/developers/quickstart)
- [Models](https://docs.x.ai/developers/models)
- [Grok 4.5 model](https://docs.x.ai/developers/models/grok-4.5)
- [Grok 4.3 model](https://docs.x.ai/developers/models/grok-4.3)
- [Generate text (Responses API)](https://docs.x.ai/developers/model-capabilities/text/generate-text)
- [Streaming](https://docs.x.ai/developers/model-capabilities/text/streaming)
- [Structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
- [Function calling](https://docs.x.ai/developers/tools/function-calling)
- [Chat Completions (legacy guide)](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions)
- [Rate limits](https://docs.x.ai/developers/rate-limits)
- [Inference REST overview](https://docs.x.ai/developers/rest-api-reference/inference)
- [Chat / Responses REST reference](https://docs.x.ai/developers/rest-api-reference/inference/chat)
- [Legacy REST](https://docs.x.ai/developers/rest-api-reference/inference/legacy)
