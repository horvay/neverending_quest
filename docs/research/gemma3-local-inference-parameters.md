# Gemma local inference parameters for Artemis-31B-v1.1

## Answer in brief

**Artemis-31B-v1.1 is a Gemma 4 model, not a Gemma 3 model.** The first-party Artemis repository declares `base_model: google/gemma-4-31B-it`; its live model metadata reports `model_type: "gemma4"`, architecture `Gemma4ForConditionalGeneration`, and 31,273,088,876 parameters ([Artemis model card](https://huggingface.co/TheDrummer/Artemis-31B-v1.1), [repository metadata](https://huggingface.co/api/models/TheDrummer/Artemis-31B-v1.1)). Google's parent card describes Gemma 4 31B as a 30.7B dense model and contrasts it directly with Gemma 3 27B ([Google Gemma 4 31B model card](https://huggingface.co/google/gemma-4-31B-it)).

The appropriate published starting samplers are therefore the **Gemma 4 31B base-family settings**: temperature `1.0`, top-p `0.95`, and top-k `64`. Google calls this its standardized configuration across use cases ([Gemma 4 model card, “Best Practices”](https://huggingface.co/google/gemma-4-31B-it#best-practices)); the same values are encoded in both the [Google parent `generation_config.json`](https://huggingface.co/google/gemma-4-31B-it/blob/842da3794eaa0b77d5f08bae87a17459d91ff475/generation_config.json) and the [Artemis `generation_config.json`](https://huggingface.co/TheDrummer/Artemis-31B-v1.1/blob/d613e5a4ee45e0fcf1f61ea3e10b6438bbe421cc/generation_config.json). Google's base-family material specifies neither min-p nor repetition penalty. The Drummer-attributed sheet adds an Artemis-specific min-p range, but still gives no conventional repetition-penalty value.

## Base-model guidance, separated by generation

| Setting | Gemma 3 27B IT | Gemma 4 31B IT (the relevant parent) |
| --- | --- | --- |
| Temperature | `1.0` in Google's model-repository generation config | `1.0` |
| Top-p | `0.95` in Google's model-repository generation config | `0.95` |
| Top-k | `64` in Google's model-repository generation config | `64` |
| Min-p | Not explicitly published | Not explicitly published |
| Repetition penalty | Not explicitly published | Not explicitly published |
| Chat format | Gemma 3-era `<start_of_turn>user` / `<start_of_turn>model`; no separate system turn | Gemma 4 `<|turn>system`, `<|turn>user`, and `<|turn>model`; optional thinking control tokens |

For Gemma 3, the numeric entries above come from the official [`google/gemma-3-27b-it` `generation_config.json`](https://huggingface.co/google/gemma-3-27b-it/blob/005ad3404e59d6023443cb575daa05336842228a/generation_config.json), not from the prose model card. Google's current inference guide instructs users to load the repository's `GenerationConfig` rather than restating sampler values ([Google Hugging Face inference guide](https://ai.google.dev/gemma/docs/core/huggingface_inference)). The official Gemma 3 model card establishes that 27B IT is a Gemma 3 model, but does not state min-p or repetition-penalty recommendations ([Google Gemma 3 model card](https://ai.google.dev/gemma/docs/core/model_card_3)).

The template generations are not interchangeable. Google documents Gemma 3 and earlier as using `<start_of_turn>` / `<end_of_turn>`, only `user` and `model` roles, with system-level instructions folded into the first user message ([Gemma 3-era formatting guide](https://ai.google.dev/gemma/docs/core/prompt-structure)). Gemma 4 introduces `<|turn>` / `<turn|>`, a native `system` role, and `<|think|>` plus thought-channel tokens ([Gemma 4 prompt-formatting guide](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4)).

## Artemis-specific first-party guidance

The Artemis model card gives these explicit usage directions:

- use the **Gemma 4 31B template**;
- thinking and non-thinking operation are supported;
- standard Gemma thinking formatting is supported, and the card also says custom `<thinking>...</thinking>`, `<think>...</think>`, and similarly named blocks can be prompted;
- sampler suggestions are delegated to a linked **crowdsourced** spreadsheet.

Source: [TheDrummer/Artemis-31B-v1.1, “Usage”](https://huggingface.co/TheDrummer/Artemis-31B-v1.1#usage). The first-party GGUF card repeats the same guidance ([TheDrummer/Artemis-31B-v1.1-GGUF](https://huggingface.co/TheDrummer/Artemis-31B-v1.1-GGUF#usage)).

The prose card itself does not print a numeric preset, but it links a sampler sheet containing cells explicitly labeled **“Drummer Sampler Recommendations.”** Those author-attributed cells recommend temperature `1.0`; min-p `0.02–0.05`; DRY multiplier `0.8`, base `1.7`, allowed length `2`, and the default sequence breakers; and adaptive-p target `0.6` with decay `0.5`. They also give a more aggressive adaptive-p alternative of target `0.25` with decay `0.95` ([sampler sheet linked by TheDrummer](https://docs.google.com/spreadsheets/d/1wil6YEHTnQP3DO9EF35ImQMY3lbmRt5_ns-LJavUqwQ)). These are **Artemis-specific, author-attributed finetune recommendations**, distinct from Google's base-family generation config. The cited cells do not specify top-p, top-k, or a conventional repetition penalty, so no Artemis-specific values for those fields should be invented.

The Artemis repository also ships temperature `1.0`, top-p `0.95`, and top-k `64`, exactly matching the parent repository. Treating those three as inherited Gemma 4 defaults rather than evidence of a separately tuned creative-writing preset is an **inference**.

For thinking, prefer the canonical template switch supplied by the runtime. Google specifies that Gemma 4 thinking is activated with `<|think|>` in the system instruction and that ordinary multi-turn history must omit prior raw thoughts (except within a tool-call turn) ([Google Gemma 4 prompt-formatting guide](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4#thinking-mode)). The Artemis card's alternative tag tricks describe finetune behavior, not a replacement for the Gemma 4 chat template.

## `llama-server` mapping

For a local GGUF and a recent `llama-server`, the faithful translation of the published Gemma 4 / repository settings is:

```sh
llama-server \
  -m /path/to/Artemis-31B-v1.1.gguf \
  --temp 1.0 \
  --top-p 0.95 \
  --top-k 64 \
  --min-p 0 \
  --repeat-penalty 1 \
  --jinja \
  --reasoning auto
```

That is the **Google-base-faithful** configuration. To apply Drummer's primary Artemis-specific recommendations, change/add:

```sh
  --min-p 0.02 \
  --dry-multiplier 0.8 \
  --dry-base 1.7 \
  --dry-allowed-length 2 \
  --adaptive-target 0.6 \
  --adaptive-decay 0.5 \
  --samplers 'penalties;dry;top_n_sigma;top_k;typ_p;top_p;min_p;xtc;temperature;adaptive_p'
```

Any min-p value through `0.05` remains inside the recommended range. For the sheet's aggressive alternative, replace only the adaptive pair with `--adaptive-target 0.25 --adaptive-decay 0.95`. Do not pass `--dry-sequence-breaker`; llama.cpp then retains its default breakers (`\n`, `:`, `"`, and `*`).

For an Atomic/native llama-server request, the corresponding JSON fields are:

```json
{
  "temperature": 1.0,
  "top_p": 0.95,
  "top_k": 64,
  "min_p": 0.02,
  "repeat_penalty": 1.0,
  "dry_multiplier": 0.8,
  "dry_base": 1.7,
  "dry_allowed_length": 2,
  "adaptive_target": 0.6,
  "adaptive_decay": 0.5,
  "samplers": [
    "penalties", "dry", "top_n_sigma", "top_k", "typ_p",
    "top_p", "min_p", "xtc", "temperature", "adaptive_p"
  ]
}
```

The exact Atomic keys are `adaptive_target` and `adaptive_decay`. Setting those numbers alone is insufficient: llama.cpp only constructs the adaptive-p sampler when `adaptive_p` is explicitly present in `samplers` ([server request schema](https://github.com/ggml-org/llama.cpp/blob/9cffdcc801582616250520966699cb5b25d28243/tools/server/server-schema.cpp#L167-L173), [sampler construction](https://github.com/ggml-org/llama.cpp/blob/9cffdcc801582616250520966699cb5b25d28243/common/sampling.cpp#L342-L399)). The server schema likewise defines the DRY request keys shown above ([DRY fields](https://github.com/ggml-org/llama.cpp/blob/9cffdcc801582616250520966699cb5b25d28243/tools/server/server-schema.cpp#L139-L151)) and accepts `samplers` as an array of sampler names ([`samplers` field](https://github.com/ggml-org/llama.cpp/blob/9cffdcc801582616250520966699cb5b25d28243/tools/server/server-schema.cpp#L501-L504)).

| Published concept | `llama-server` flag | Status |
| --- | --- | --- |
| Temperature `1.0` | `--temp 1.0` | Direct mapping |
| Top-p `0.95` | `--top-p 0.95` | Direct mapping |
| Top-k `64` | `--top-k 64` | Direct mapping |
| Min-p | `--min-p 0.02` through `--min-p 0.05` | Artemis-specific range from the Drummer-attributed sheet. Use `--min-p 0` only for a strictly Google-base-faithful run. |
| Repetition penalty | `--repeat-penalty 1` | **Not a model recommendation.** No first-party model value exists; `1` is llama.cpp's disabled/neutral value. |
| Repository chat template | `--jinja`; do not override `--chat-template` | Use the Jinja template embedded in GGUF metadata. |
| DRY | `--dry-multiplier 0.8 --dry-base 1.7 --dry-allowed-length 2` | Artemis-specific Drummer recommendation; omit `--dry-sequence-breaker` to retain llama.cpp's documented default breakers. |
| Adaptive-p, primary | `--adaptive-target 0.6 --adaptive-decay 0.5` | Artemis-specific Drummer recommendation; requires `adaptive_p` in `--samplers`. |
| Adaptive-p, aggressive | `--adaptive-target 0.25 --adaptive-decay 0.95` | Author-attributed alternate; use instead of, not together with, the primary pair. |
| Thinking choice | `--reasoning auto`, or explicitly `on` / `off` | Runtime mapping of the user's desired mode, not a sampling default. |

The llama.cpp server documentation defines the exact flag names and also shows why they should be explicit: its own defaults are temperature `0.80`, top-k `40`, top-p `0.95`, min-p `0.05`, and repetition penalty `1.00`; min-p `0.0` and repetition penalty `1.0` disable those samplers ([llama.cpp server sampling parameters](https://github.com/ggml-org/llama.cpp/blob/9cffdcc801582616250520966699cb5b25d28243/tools/server/README.md#sampling-params)). Thus bare llama.cpp defaults diverge from the Google baseline on temperature, top-k, and min-p. The llama.cpp min-p default `0.05` happens to equal the upper end of Drummer’s Artemis range, but it is not evidence that llama.cpp selected that value for Artemis.

The same server documentation says Jinja is enabled by default, the chat template defaults to model metadata, and `--reasoning` supports `on`, `off`, or template-detected `auto` ([llama.cpp server-specific parameters](https://github.com/ggml-org/llama.cpp/blob/9cffdcc801582616250520966699cb5b25d28243/tools/server/README.md#server-specific-params)). Keeping `--jinja` in the example makes the requirement explicit and remains compatible with versions where it was not the default. Do not substitute the older built-in `gemma` template for the model's embedded Gemma 4 Jinja template.

Per-request OpenAI-compatible fields can override the server-wide sampler values; if callers do that, preserve the same values (`temperature`, `top_p`, `top_k`, `min_p`, and `repeat_penalty`) or document the deliberate departure.

## Local verification on the installed GGUF

The installed `Artemis-31B-v1.1-heretic.i1-IQ3_XS.gguf` was exercised through Atomic's OpenAI-compatible chat endpoint with the embedded Gemma 4 Jinja template. The request used temperature `1.0`, top-p `0.95`, top-k `64`, min-p `0.02`, DRY `0.8 / 1.7 / 2`, the four recommended sequence breakers, adaptive target `0.6`, adaptive decay `0.5`, neutral repetition penalty, and an explicit sampler chain ending in `adaptive_p`. Thinking was disabled to isolate ordinary text generation.

The prompt requested one grammatical sentence about a blue lantern beside a closed door. The model instead produced:

```text
A blue lantern lits a de a lits lits de a de lits lits lits lits a lits...
```

The same installed GGUF had already degenerated under min-p `0.05`, the aggressive adaptive pair `0.25 / 0.95`, Q8 KV cache, and a separate mainline llama.cpp build. A raw `/completion` request that bypassed the chat template also collapsed into repeated `a` and `l` fragments. Therefore the recommended sampler settings do not repair this particular GGUF. The evidence points to the `heretic.i1-IQ3_XS` conversion or file, rather than the Gemma 4 template or sampler configuration.

## What is fact and what remains uncertain

**Documented facts**

1. Artemis-31B-v1.1 declares Gemma 4 31B IT as its base and reports Gemma 4 architecture metadata.
2. Google publishes `1.0 / 0.95 / 64` for Gemma 4 temperature / top-p / top-k; both the Google parent and Artemis repository generation configs encode it.
3. TheDrummer explicitly asks users to use the Gemma 4 31B template and permits thinking or non-thinking use.
4. Google's base-family material specifies neither min-p nor repetition penalty. The Drummer-attributed sheet specifies min-p `0.02–0.05`, but no conventional repetition penalty.

**Inference / operational decision**

- `--min-p 0` and `--repeat-penalty 1` are the neutral choices for a strictly Google-base-faithful run; they do **not** claim model defaults. For Artemis, Drummer instead recommends min-p `0.02–0.05`; repetition penalty remains unspecified.
- `1.0 / 0.95 / 64` is the Google/repository baseline. The sheet's min-p, DRY, and adaptive-p values are the separate Artemis-specific recommendations; its more aggressive adaptive pair is explicitly an alternative.

## Source revisions consulted

- `TheDrummer/Artemis-31B-v1.1` revision [`d613e5a4ee45e0fcf1f61ea3e10b6438bbe421cc`](https://huggingface.co/TheDrummer/Artemis-31B-v1.1/tree/d613e5a4ee45e0fcf1f61ea3e10b6438bbe421cc)
- `google/gemma-4-31B-it` revision [`842da3794eaa0b77d5f08bae87a17459d91ff475`](https://huggingface.co/google/gemma-4-31B-it/tree/842da3794eaa0b77d5f08bae87a17459d91ff475)
- `google/gemma-3-27b-it` revision [`005ad3404e59d6023443cb575daa05336842228a`](https://huggingface.co/google/gemma-3-27b-it/tree/005ad3404e59d6023443cb575daa05336842228a)
- `ggml-org/llama.cpp` revision [`9cffdcc801582616250520966699cb5b25d28243`](https://github.com/ggml-org/llama.cpp/tree/9cffdcc801582616250520966699cb5b25d28243)

