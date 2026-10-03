# Ternary-Bonsai-27B local inference envelope

Research note for Neverending Quest. v1 Provider is the user's Grok account; this document captures the **later local bar** the architecture must not paint into a corner on.

Primary sources:

- [prism-ml/Ternary-Bonsai-27B-gguf](https://huggingface.co/prism-ml/Ternary-Bonsai-27B-gguf) model card (Hugging Face)
- [Qwen/Qwen3.6-27B](https://huggingface.co/Qwen/Qwen3.6-27B) parent model card
- [PrismML-Eng/Bonsai-demo](https://github.com/PrismML-Eng/Bonsai-demo) (README, TOOLS.md, KV-CACHE.md, AGENTS.md, start scripts)
- [ggml-org/llama.cpp `tools/server/README.md`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [ggml-org/llama.cpp `docs/function-calling.md`](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)

---

## Model identity

| Item | Spec |
| --- | --- |
| Pack | `prism-ml/Ternary-Bonsai-27B-gguf` |
| Base | Derived from `Qwen/Qwen3.6-27B` (architecture unchanged) |
| Params | ~27.3B ternary language weights + optional ~0.46B vision tower |
| Architecture | Hybrid attention (~75% linear / ~25% full), SwiGLU, RoPE, RMSNorm; 64 blocks, full-attention KV on **16 of 64** layers |
| Context (native) | **262,144** tokens (parent also documents YaRN extensibility toward ~1M) |
| Weight format | Ternary {−1, 0, +1} in GGUF 2-bit slots with FP16 group scales (~1.71 true bpw ideal; ~2.125 bpw deployed) |
| License | Apache-2.0 |

Sources: Ternary-Bonsai-27B-gguf model card; Qwen3.6-27B model card.

---

## Quantization / shipped GGUF variants

Files present on the HF GGUF repo (sizes from tree listing / card):

| File | Role | On-disk size (approx.) | Runtime note |
| --- | --- | --- | --- |
| `Ternary-Bonsai-27B-Q2_0.gguf` | **Primary text LM** — group-128 ternary (`Q2_0_g128`) | ~7.17 GB (card); ~6.66 GiB reported by llama-bench | Demo default; historically Prism fork packing. Card treats this as the quality-oriented operating point. |
| `Ternary-Bonsai-27B-Q2_g64.gguf` | Group-64 ternary pack | ~7.59 GB | **Mainline-compatible** packing (upstream llama.cpp Q2_0 g64). Prefer this on stock `ggml-org/llama.cpp`. |
| `Ternary-Bonsai-27B-PQ2_0.gguf` | Migration placeholder | ~7.17 GB | Demo README: **do not depend on yet** — experimental, format/name may change. |
| `Ternary-Bonsai-27B-F16.gguf` | FP16 reference LM | ~53.8 GB | Not a deploy target for local laptop play. |
| `Ternary-Bonsai-27B-dspark-Q4_1.gguf` | Speculative drafter (default) | ~1.95 GB | Optional; fork packing — mainline cannot load Prism dspark packs today. |
| `Ternary-Bonsai-27B-dspark-bf16.gguf` | Speculative drafter (reference) | ~7.29 GB | Optional quality/speed reference for drafter. |
| `Ternary-Bonsai-27B-mmproj-Q8_0.gguf` | Vision projector (HQQ 4-bit in Q8_0 container) | ~0.63 GB | Optional; load only for image input. |
| `Ternary-Bonsai-27B-mmproj-BF16.gguf` | Vision projector reference | ~0.93 GB | Optional. |

Companions (not this pack, but same family bar):

- 1-bit phone-class: `prism-ml/Bonsai-27B-gguf` (~3.9 GB language footprint).
- MLX Apple Silicon: `prism-ml/Ternary-Bonsai-27B-mlx-2bit`.

**Architecture implication:** treat “local Bonsai” as **one OpenAI-compatible endpoint + one GGUF path**, not a hard-coded quant filename. Support at least `Q2_0` (fork g128) and `Q2_g64` (mainline) without baking fork-only features (DSpark) into the core Provider contract.

Sources: HF repo tree; Ternary-Bonsai-27B-gguf card “Shipped Components”; Bonsai-demo README “Upstream Status for Ternary”.

---

## Context length options

| Knob | Practical value | Source |
| --- | --- | --- |
| Model max | **262,144** tokens | Card + Qwen3.6-27B (“262,144 natively”) |
| Demo script default | RAM-tiered auto, **8K → 131K**, never silently `-c 0` (full train ctx) | Bonsai-demo README / AGENTS.md |
| Full window override | `BONSAI_CTX=262144` explicit | Demo scripts |
| Speculative path floor | Script forces **16,384** ctx when DSpark is on and ctx was auto | `start_llama_server.sh` |
| Parent long-ctx extension | YaRN toward ~1,010,000 tokens (static YaRN can hurt short texts) | Qwen3.6-27B card |

Hybrid attention keeps KV cheap relative to a dense full-attention 27B: full-attention cache grows on only 16/64 layers. Card: FP16 KV ~**4.3 GB at full 262K** for that full-attention subset; demo AGENTS.md quotes **~64 KiB/token** FP16 KV for the 27B stack (~6.3 GiB at 100K).

**4-bit KV cache (opt-in):** `--cache-type-k q4_0 --cache-type-v q4_0` (requires flash-attn). Demo: ~3.5× smaller KV (~18 KiB/token → ~1.8 GiB at 100K). Optional mean-centering bias via `make_kv_bias.sh`. Experimental; slight decode slowdown.

**Architecture implication:** Context Assembly and Campaign pin policy must accept **variable local ctx** (often 8–32K on modest machines, up to 100K+/262K on fat RAM/VRAM). Do not assume cloud-scale windows. Prefer **Dossiers + Player Sheet first, then recent messages** under pressure (standing map choice) — local KV cost makes that non-optional.

---

## Resource envelope (VRAM / RAM)

### Weights + peak memory (language model only)

From the Ternary-Bonsai-27B-gguf card (decimal GB, **no** KV-cache compression; ~1.3 GB activations/runtime buffers included in peaks):

| Build | Weights | 4K | 10K | 100K |
| --- | ---: | ---: | ---: | ---: |
| Ternary Bonsai llama.cpp Q2_0 | 7.15 | 8.4 | 8.7 | **14.7** |
| Conventional Q4_K_XL ref | 17.6 | 19.2 | 19.6 | 25.6 |
| BF16 ref | 51.25 | 52.6 | 53.3 | 59.3 |

With **4-bit KV**: card states 100K peak drops to **~10.1 GB**; full **262K fits ~12.8 GB** peak.

Demo README (GiB, text-only; add ~0.9 GiB if mmproj resident):

| Format | Weights | 4K | 10K | 100K |
| --- | ---: | ---: | ---: | ---: |
| Ternary llama.cpp Q2_0 | 6.66 | 7.8 | 8.1 | 13.7 |
| Ternary MLX 2-bit | 7.05 | 8.6 | 8.9 | 14.4 |

Deployed LM footprint card headline: **~7.2 GB** (ideal ternary math 5.9 GB; 2-bit slot packing today).

### Throughput (card + community)

| Platform | TG128 (tok/s) | Notes |
| --- | ---: | --- |
| Apple M5 Pro Metal | ~26 | Card headline interactive laptop rate |
| Apple M5 Max Metal | ~44 | Card |
| Apple M4 Pro Metal | ~18 | Card |
| H100 CUDA | ~98 (→ ~132 w/ DSpark 1.34×) | Card |
| **RTX 3080 Ti 12 GB (WSL, community)** | **~63 tg128**; ~65 → ~96 tok/s w/ DSpark on short codegen | [community-benchmarks/ternary-bonsai/cuda-rtx3080ti-wsl.md](https://github.com/PrismML-Eng/Bonsai-demo/blob/main/community-benchmarks/ternary-bonsai/cuda-rtx3080ti-wsl.md) — **full GPU fit** for bench ctx |

### Fit rules of thumb

- **Single consumer 12 GB GPU** (e.g. 3080 Ti): LM weights fit; short/medium ctx interactive. Long ctx (100K FP16 KV) needs system RAM offload, fewer layers on GPU, and/or `BONSAI_KV4=1`. Speculative drafter adds ~2 GB — tight on 12 GB at large ctx.
- **24 GB single GPU**: card positions high-throughput + long-context as practical with KV quant.
- **Laptop unified memory ≥16–32 GB**: ternary 27B is the intended quality bar; demo auto-ctx tiers protect against OOM.
- **Phone / ≤6 GB per-app**: ternary **does not fit**; 1-bit companion is the phone path (out of scope for NQ desktop TUI, but shows the family split).

**Architecture implication:** Provider health checks should surface **effective context**, not advertise 262K blindly. Generation latency on local will be **tens of tok/s**, not cloud; TUI must tolerate slower streams and large **thinking** preambles.

---

## Smallest honest OpenAI-compatible server path

### Recommended path (text GM turns)

1. Obtain weights: `Ternary-Bonsai-27B-Q2_g64.gguf` on **recent mainline** `ggml-org/llama.cpp`, **or** `Ternary-Bonsai-27B-Q2_0.gguf` via Prism demo/fork binaries (still the one-command path).
2. Build/run `llama-server` with GPU offload and flash-attn:

```bash
./llama-server \
  -m Ternary-Bonsai-27B-Q2_0.gguf \
  --host 127.0.0.1 --port 8080 \
  -ngl 99 -fa on \
  -c 16384 \
  --temp 0.7 --top-p 0.95 --top-k 20 \
  --jinja \
  -a ternary-bonsai-27b
```

3. Client: any OpenAI SDK pointed at `http://127.0.0.1:8080/v1` with a dummy API key.

Endpoints that matter (server README):

| Route | Use |
| --- | --- |
| `POST /v1/chat/completions` | Primary chat + tools + `response_format` |
| `GET /v1/models` | Model id/alias discovery |
| `GET /health`, `GET /props` | Readiness + effective caps |
| `POST /v1/completions` | Raw completions if needed |
| Native `/completion`, `/apply-template` | Escape hatches; prefer not to require these in the app core |

Optional:

- `--mmproj …` only if image input is ever in scope (NQ v1 is TUI text).
- `BONSAI_SPECULATIVE=1` / `--spec-type draft-dspark -md …dspark-Q4_1.gguf` for CUDA speed — **fork drafter packing**, disables multi-slot prompt-cache reuse; keep **out of** the required Provider path.
- `BONSAI_KV4=1` for long Campaign contexts on tight VRAM.

Demo `start_llama_server.sh` for 27B also sets `--jinja`, sampling 0.7/0.95/20, optional mmproj, and leaves **thinking on** (budget via `--reasoning-budget` or per-request UI).

**Architecture implication:** abstract Provider as **OpenAI Chat Completions–shaped** (`base_url`, `api_key`, `model`). Local = same interface, different base URL + smaller default `max_tokens` / ctx. Do not require Anthropic-only or Grok-only request fields in the core loop.

Sources: llama.cpp server README; Bonsai-demo `start_llama_server.sh`; HF card Quickstart.

---

## Prompt format and thinking gotchas

Inherited from **Qwen3.6-27B** chat template behavior:

1. **Thinking is default.** Qwen3.6 does **not** support the older Qwen3 soft switches `/think` and `/nothink`. Disable thinking via template kwargs, not magic tokens:
   - API: `chat_template_kwargs: {"enable_thinking": false}` (llama-server documents this field on `/v1/chat/completions`).
   - Server flags: `--reasoning off` / `--chat-template-kwargs '{"enable_thinking": false}'` / `--reasoning-budget 0` patterns used for smaller Bonsai sizes in the demo script.
2. **Preserve thinking (optional).** Parent card: `chat_template_kwargs: {"preserve_thinking": true}` keeps historical reasoning traces (better for multi-step agents; can improve KV reuse). Default is interleaved (only latest turn’s think block retained).
3. **Reasoning surface.** llama-server can split thoughts into `message.reasoning_content` (`--reasoning-format deepseek` / auto). TUI must either show, collapse, or strip this — and **must not** treat reasoning as player-visible story unless product says so.
4. **Thinking burns the generation budget.** On slow hardware, most latency is reasoning tokens. Cap with `--reasoning-budget N` or per-request budget; demo UI maps Off/512/2048/8192/unlimited.
5. **Sampling defaults diverge by source:**
   - Bonsai GGUF card (thinking benchmarks): **temp 0.7, top_p 0.95, top_k 20**.
   - Qwen3.6 parent “thinking, general”: **temp 1.0, top_p 0.95, top_k 20**; coding-precise thinking: temp **0.6**; non-thinking: temp **0.7**, top_p **0.8**, **presence_penalty 1.5**.
   - Demo server 27B: matches Bonsai card (0.7 / 0.95 / 20).
6. **System prompt:** card allows a simple “You are a helpful assistant”; NQ will use a fixed GM seed — keep system+tool schemas inside the **pinned** prefix so prompt cache can reuse them.
7. **Output length headroom:** Qwen recommends large `max_tokens` (32k typical, up to ~80k for hard reasoning). Local ctx must reserve room for **think + answer + side-channel**; cloud Grok limits will differ — budget math belongs in Context Assembly, not hard-coded to one Provider.

Sources: Qwen3.6-27B model card (Instruct mode, Preserve Thinking, Best Practices); llama-server README (`chat_template_kwargs`, reasoning flags); Bonsai AGENTS.md / start script.

---

## Tools and structured-output reliability

### What the sources claim

| Signal | Value | Caveat |
| --- | --- | --- |
| Agentic / tool-calling bench (thinking mode) | Ternary **74.01** vs FP16 **80.00** (BFCL v3 + τ²-Bench category) | Card: retains agentic behavior better than conventional sub-4-bit; still a **~6 pt** gap vs FP16 |
| BFCL v3 alone | 74.41 vs 77.10 FP16 | |
| τ²-Bench | 73.61 vs 82.90 FP16 | Larger drop on this bench |
| Instruction following | IFEval 85.03 / IFBench 58.50 vs 88.91 / 68.03 | Structured adherence is **not** perfect |
| Card limitation | “**Agentic coding** (long-horizon, multi-file, run-test-and-repair) is not yet a strong target of this release” | Roadmap item — do not plan NQ memory authorship on coding-agent strength |
| Demo verification | Native OpenAI `tools` → `tool_calls` round-trips work with `--jinja` on llama-server and MLX server | First-party demo claim (AGENTS.md / TOOLS.md), not a formal eval |

### llama.cpp server mechanisms

- **Tool calling:** requires `--jinja`. Request field `tools` (+ `tool_choice`, optional `parallel_tool_calls`). Universal handlers exist; quality depends on the model’s native template (Qwen-family templates are first-class in function-calling docs historically; 3.6 follows the same OpenAI tools path in the Bonsai demo).
- **Structured JSON:** `response_format` supports `json_object` and schema-constrained JSON (`json_schema` / schema embedded). Also CLI `--json-schema` / grammar sampling. This is the right **local** hammer for Side-channel ops when free-form tool JSON is flaky.
- **MCP / built-in agent tools:** demo and server extras — **not** required for NQ; tool schema tokens can cost thousands of prompt tokens if left always-on.

### Architecture implications (do not paint into a corner)

1. **Same-model structured Side-channel stays viable**, but must assume **lower reliability than Grok**: validate schemas, reject/repair malformed ops, never let partial memory apply corrupt the Campaign silently.
2. Prefer **constrained decoding** (`response_format` / grammar) for memory ops on local, even if Grok path uses looser prompting — Provider capability flags (`supports_json_schema`, `supports_tools`) beat one global prompt strategy.
3. **Do not hard-mandate tool calling** as the only memory path (matches standing map choice). Tools are optional accelerators; parseable side-channel text + schema constraint must work when `tool_calls` are empty or wrong.
4. Budget **thinking + tool schema + dossiers** explicitly. Local 16K ctx with a fat tool list and uncapped think will starve story tokens.
5. Expect **finish_reason / streaming quirks** differences vs Grok; normalize in the Provider adapter (content vs `reasoning_content` vs `tool_calls`).

Sources: Ternary-Bonsai card Benchmarks + Limitations; llama-server README function calling & `response_format`; function-calling.md; Bonsai-demo TOOLS.md / AGENTS.md.

---

## Constraints checklist for the NQ architecture

| # | Constraint | Why |
| --- | --- | --- |
| 1 | Provider = OpenAI Chat Completions–compatible client (`base_url` swappable) | Honest local path is `llama-server` `/v1/*` |
| 2 | No Grok-only request fields in the turn core | Local cannot satisfy proprietary extras |
| 3 | Pluggable model id + optional `chat_template_kwargs` / reasoning budget | Qwen3.6 thinking defaults on; local needs kill-switch |
| 4 | Context Assembly parameterized by **runtime ctx & tokenizer**, not a single cloud limit | 8K–262K real range; KV memory dominates |
| 5 | Pin order under pressure: Dossiers + Player Sheet, then recent turns | Standing product choice; critical when local peak RAM is ~10–15 GB at long ctx |
| 6 | Side-channel: schema validate + constrained decode path; tools optional | Ternary tool benches ~74 vs 80 FP16; IFBench weaker; card warns on long-horizon agentic coding |
| 7 | Stream UI must handle slow tok/s and optional `reasoning_content` | ~20–60 tok/s class on consumer GPUs/laptops |
| 8 | Do not require DSpark, mmproj, MCP, or Prism fork in v1 local profile | Nice speedups; mainline + `Q2_g64` is enough for text GM |
| 9 | Capability discovery (`/props`, `/v1/models`) over hard-coded 262K/tool claims | Effective ctx is machine- and flag-dependent |
| 10 | Quant path treated as deploy detail | g128 fork vs g64 mainline vs future PQ2_0 must not fork app logic |

---

## Minimal local profile (suggested default for a later swap)

When a runbook is written (out of band from this research ticket):

- Model file: `Ternary-Bonsai-27B-Q2_g64.gguf` (mainline) or demo `Q2_0` with Prism binaries.
- Server: `llama-server -ngl 99 -fa on -c <RAM-safe> --jinja --temp 0.7 --top-p 0.95 --top-k 20`.
- App: `base_url=http://127.0.0.1:8080/v1`, reasoning budget capped for interactive play (e.g. 512–2048), `response_format` JSON schema for Side-channel when applying memory ops.
- Skip mmproj, DSpark, and always-on MCP unless a feature explicitly needs them.

---

## Sources (link list)

1. https://huggingface.co/prism-ml/Ternary-Bonsai-27B-gguf  
2. https://huggingface.co/Qwen/Qwen3.6-27B  
3. https://github.com/PrismML-Eng/Bonsai-demo  
4. https://github.com/PrismML-Eng/Bonsai-demo/blob/main/TOOLS.md  
5. https://github.com/PrismML-Eng/Bonsai-demo/blob/main/KV-CACHE.md  
6. https://github.com/PrismML-Eng/Bonsai-demo/blob/main/AGENTS.md  
7. https://github.com/PrismML-Eng/Bonsai-demo/blob/main/scripts/start_llama_server.sh  
8. https://github.com/PrismML-Eng/Bonsai-demo/blob/main/community-benchmarks/ternary-bonsai/cuda-rtx3080ti-wsl.md  
9. https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md  
10. https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md  
11. https://github.com/PrismML-Eng/llama.cpp (fork referenced by card for Q2_0_g128 / DSpark packing)  
