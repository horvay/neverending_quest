# Anima prompting

## Answer in one paragraph

`circlestone-labs/Anima` accepts Danbooru-style tags, natural-language captions, or a mix of the two. It does not require one format. For tags, use lowercase and spaces rather than underscores, except for the exact `score_*` tags. Put control and identity tags first, then content details. For prose, write at least two descriptive sentences. A practical default is a hybrid: a short quality and safety prefix followed by explicit prose. These rules come from the [official model card at repository revision `f973fc4`](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#prompting).

## Model identity and versions

Anima is the 2 billion parameter CircleStone Labs and Comfy Org text-to-image model derived from `nvidia/Cosmos-Predict2-2B-Text2Image`. It targets anime and other non-photorealistic illustration, not realism. This identity and base model are stated in the [official model card](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md) and corroborated by the [official ComfyUI guide](https://github.com/Comfy-Org/docs/blob/c18261940128bb2c391e01203bedd9fd422ea20f/tutorials/image/anima/anima.mdx).

The official repository currently contains these relevant checkpoint families in its [pinned diffusion-model tree](https://huggingface.co/circlestone-labs/Anima/tree/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/diffusion_models):

- **Base v1.0** is the unrefined pretrained model. The card says it has the most flexibility, diversity, and style adherence, and recommends it for LoRA training.
- **Aesthetic v1.0, v1.0b, and v1.1** trade some base-model neutrality for a more consistent default style. The card explains only the v1.0 versus v1.0b distinction: v1.0b is an aesthetics full fine-tune without the style-adjustment and stabilization LoRAs merged into v1.0. It does not explain what changed in v1.1.
- **Turbo v1.0 and v1.1** are distilled checkpoints. The card says Turbo is faster and more stable, with a stronger default style and less diversity. It recommends CFG 1 and 8 to 12 steps. It does not document a prompting-syntax difference or explain what changed in v1.1.
- The repository also retains preview checkpoints. Treat them as historical or early-access variants, not the default starting point. The [ComfyUI guide](https://github.com/Comfy-Org/docs/blob/c18261940128bb2c391e01203bedd9fd422ea20f/tutorials/image/anima/anima.mdx#available-workflows) separates Base v1 from Preview.

The card recommends starting with Turbo. For Base and Aesthetic, its general generation range is 30 to 50 steps at CFG 4 to 5. Those settings matter here because using the current Turbo settings on Base or Aesthetic changes how strongly positive and negative conditioning acts. See [Versions](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#versions) and [Generation settings](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#generation-settings).

## VRAM requirements

The official files establish a 5.24 GiB lower bound for an unquantized installation if the diffusion model, text encoder, and VAE are resident together:

| Component | File size |
| --- | ---: |
| Anima Base, Aesthetic, or Turbo diffusion model | 3.90 GiB |
| Qwen3 0.6B text encoder | 1.11 GiB |
| Qwen Image VAE | 0.24 GiB |
| **Total weights** | **5.24 GiB** |

The byte sizes come from the official Hugging Face repository's [diffusion-model](https://huggingface.co/api/models/circlestone-labs/Anima/tree/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/diffusion_models), [text-encoder](https://huggingface.co/api/models/circlestone-labs/Anima/tree/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/text_encoders), and [VAE](https://huggingface.co/api/models/circlestone-labs/Anima/tree/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/vae) listings. Runtime VRAM must also hold activations, attention workspaces, latent tensors, and allocator overhead. CircleStone does not publish a measured peak-VRAM figure.

For batch size 1 near one megapixel, **budget roughly 7 to 8 GiB for native FP16/BF16 inference**. This is an engineering estimate from the 5.24 GiB resident-weight floor, not an official benchmark. ComfyUI can offload the text encoder and VAE when memory is tight, so lower-VRAM cards may run it more slowly. A repository user reports running 1280 by 1280 generations on a 12 GiB RTX 3060, while another reports that a 4 GiB GTX 970 works only with a Q8 GGUF and takes minutes per image ([12 GiB report](https://huggingface.co/circlestone-labs/Anima/discussions/95), [4 GiB Q8 report](https://huggingface.co/circlestone-labs/Anima/discussions/51)).

Practical inference tiers:

- **12 GiB:** comfortable for batch size 1 around 1024 by 1024, including the RTX 3080 Ti in this workstation. Keep other GPU-heavy processes out of VRAM when generating near the model's 1536 by 1536 upper range.
- **8 GiB:** expected to work at batch size 1, with less headroom and possible component offloading at larger resolutions.
- **6 GiB:** too close to the 5.24 GiB weight floor for comfortable native operation; use FP8 or GGUF quantization, lower resolution, and offloading.
- **4 GiB:** quantization plus offloading is required in practice and will be substantially slower.

Base, Aesthetic, and Turbo have the same approximately 3.90 GiB diffusion-checkpoint size. Turbo's lower step count reduces generation time, not the amount of model memory. Comfy Org officially supports FP8 export for the 2B model and keeps a minority of layers at higher precision; exact VRAM depends on the resulting artifact and runtime offloading policy ([official Anima quantization guide](https://github.com/Comfy-Org/comfy-quants/blob/main/docs/quantization/anima.md)).

## Q8 GGUF feasibility

Q8 is available, but the conversions are community artifacts rather than CircleStone releases. For the current checkpoint family, [`vanes430/Anima-Turbo-V1.1-GGUF`](https://huggingface.co/vanes430/Anima-Turbo-V1.1-GGUF) provides `anima-turbo-v1.1-Q8_0.gguf` at 2,239,471,744 bytes, or 2.09 GiB ([repository listing](https://huggingface.co/api/models/vanes430/Anima-Turbo-V1.1-GGUF/tree/main)). Base v1.0 also has a 2.09 GiB Q8 conversion in [`Abiray/Anima-base-v1.0-GGUF`](https://huggingface.co/Abiray/Anima-base-v1.0-GGUF/tree/main). Older Preview, Preview 2, and Preview 3 Q8 conversions are listed in the GGUF repository linked by stable-diffusion.cpp, but those are not the final Turbo or Aesthetic checkpoints.

A diffusion-model GGUF is not a complete Anima bundle. Anima still needs the Qwen3 0.6B text encoder and Qwen Image VAE as separate inputs. The stable-diffusion.cpp Anima guide documents `--diffusion-model`, `--llm`, and `--vae` for those three components and links compatible GGUF sources ([stable-diffusion.cpp Anima guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/anima.md)). The text encoder may remain at its official 1.11 GiB precision or use the 0.60 GiB `Q8_0` conversion listed in [`mradermacher/Qwen3-0.6B-Base-GGUF`](https://huggingface.co/api/models/mradermacher/Qwen3-0.6B-Base-GGUF/tree/main). The VAE remains 0.24 GiB.

| Q8 arrangement | Resident weight files |
| --- | ---: |
| Q8 diffusion + original text encoder + VAE | 3.43 GiB |
| Q8 diffusion + Q8 text encoder + VAE | 2.92 GiB |

Allowing for activations and runtime overhead, **roughly 4 to 6 GiB of VRAM** is a sensible batch-one planning range near one megapixel. Q8 therefore creates substantial headroom on a 12 GiB RTX 3080 Ti, but it is not required merely to make Anima fit. Quantization can also be slower than BF16 on some GPUs and runtimes; it should be chosen for memory, then compared against the native model for image quality and speed. The local test below landed inside this range.

At the original migration assessment, the installed `sd-cli` was stable-diffusion.cpp `master-820-de298c2`, but NQ still selected an Illustrious checkpoint through `-m`. That assessment is historical. The current generator supplies Anima's diffusion model, Qwen encoder, and VAE separately. See the current NQ findings below.

One licensing warning: the Turbo Q8 repository declares Apache-2.0 metadata, but the source model uses the CircleStone Labs Non-Commercial License. A third-party conversion cannot be assumed to erase the source-model terms; use the CircleStone license as the controlling restriction unless legal review establishes otherwise.

### Local Q8 smoke test

The Turbo v1.1 Q8 model was exercised through the installed `sd-cli` with the original Qwen text encoder and VAE. The test used 1344 by 768 output, batch size 1, Euler, 8 steps, CFG 1, seed `847261`, VAE tiling, and an explicit hybrid prompt requesting a nude adult elf bathing beneath a forest waterfall.

- The process exited successfully and wrote a valid 1344 by 768 PNG.
- Total generation time was 11.99 seconds. Sampling took 6.49 seconds.
- `sd-cli` reported 3,811.52 MB of model parameters in VRAM: 1,433.75 MB text encoder, 2,135.68 MB diffusion model, and 242.10 MB VAE.
- One-second `nvidia-smi` sampling observed a 5,618 MiB system-wide peak from a 550 MiB baseline, or a 5,068 MiB increase attributable to the run.
- Visual inspection found strong subject, nudity, setting, and style adherence. The model rendered an adult silver-haired elf bathing in a coherent forest pool with the waterfall behind and partly above her. The requested full-body framing became a submerged lower body, so spatial wording still needs iteration.

The downloaded diffusion GGUF, text encoder, and VAE matched their repository SHA-256/LFS hashes after one interrupted download was discarded and replaced. The test image was kept outside the repository and deleted in the 2026-10-01 cleanup.

### Incase Anima LoRA compatibility test

Civitai version `3037150` of "Incase + gothic style mix" is an Anima-specific LoRA, not the separate Illustrious build. Its metadata names `Anima` as the base model, says no trigger tag is required, and warns that results vary by checkpoint. The published examples use WAI Anima or RDBT Anima derivatives at 32 steps and CFG 4, not CircleStone Turbo ([Civitai version API](https://civitai.com/api/v1/model-versions/3037150)).

The verified `incoth.safetensors` file was applied at weight 1 to Turbo v1.1 Q8 through the installed `sd-cli`, using the same Tala prompt, seed, resolution, and generation settings as the no-LoRA comparison. Generation completed in 13.63 seconds, but stable-diffusion.cpp applied only **840 of 1,344 tensors** and reported the other 504 as unused. The output changed substantially, proving that the applied subset was active, but prompt adherence deteriorated from a seated near-full-body prison scene to a tight upper-body portrait.

Verdict: this LoRA is architecturally intended for Anima, but it is **not reliable through the current stable-diffusion.cpp path** because the loader applies only 62.5 percent of its tensors. It may work correctly in the Forge/ComfyUI path used for its published examples, and it may behave differently on the checkpoint families named there. Lowering its weight can reduce the visible effect but cannot restore the unused tensors. The comparison images were deleted in the 2026-10-01 cleanup.

### 80s Fantasy Movie Anima LoRA test

Civitai version `3002110` is an Anima-specific model-only LoRA trained against Anima Base v1.0. It uses the triggers `ArsMovieStill, 80s Fantasy Movie Still` and its published workflow applies strength 1 at 30 steps and CFG 4 ([Civitai version API](https://civitai.com/api/v1/model-versions/3002110)). The downloaded 92,414,264-byte file matched its published SHA-256, `e71f33149b90de7d27af3483b9ed435818bee817893312eef4d580a516dbfa22`.

Unlike the Incase LoRA, stable-diffusion.cpp applied **all 840 of 840 tensors** to Turbo v1.1 Q8. Four strength-1 variants produced a strong live-action 1980s fantasy-film look and retained the desert prison, full-body seated elf, collar, sandstone, pottery, and harsh sunlight. All four ignored the requested opaque chest wraps and rendered Tala topless. A second batch at strength 0.75 with repeated clothing instructions and nudity exclusions restored prison-wrap clothing and a darker sacrificial-cell environment. It still tended to place the bars behind Tala rather than between her and the camera.

This is the more compatible LoRA for the current `sd-cli` path. The best prison results came from the second batch; its images were deleted in the 2026-10-01 cleanup.

A separate strength-0.75 batch tested first-person intimate composition without visible sex acts. All four images showed an adult elf in a coherent bed-level POV with the viewer's body or hands visible. The model kept explicit genitalia and intercourse out when those were placed in the negative prompt, although three variants contained non-explicit nudity. This establishes strong adult, intimate, and first-person composition capability; it does not test visible penetration or explicit sex acts.

Those images were deleted in the 2026-10-01 cleanup.

## Prompt formats

### Tags

The documented tag syntax is comma-separated, lowercase Danbooru-style tagging with spaces in multiword tags. `score_9` through `score_1` are the sole documented underscore exception. When Danbooru and Gelbooru names differ, the card says to prefer the Gelbooru form. Training used random tag dropout, so the card explicitly says that a prompt need not enumerate every visible attribute. See [Prompting](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#prompting) and [Tag dropout](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#tag-dropout).

The recommended section order is exact:

```text
[quality/meta/year/safety] [1girl/1boy/1other etc.] [character] [series] [artist] [general tags]
```

Separate items with commas. Order within a section is arbitrary according to the [Tag order section](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#tag-order).

### Natural language

Pure prose is a trained format. The card recommends standard English capitalization for character and series names, at least two descriptive sentences, and a basic appearance description after a named character. The appearance restatement matters more with multiple characters because names alone can become confused. See [Natural language prompting tips](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#natural-language-prompting-tips).

A first-party ComfyUI workflow demonstrates that prose goes directly into the positive `CLIPTextEncode` node. Its example starts `Anime monochrome cyberpunk front portrait...`; it does not prepend a chat instruction or hidden Anima system prompt. The same workflow exposes a separate negative text field. See the [pinned workflow, positive and negative nodes](https://github.com/Comfy-Org/workflow_templates/blob/12199d938df3c531853036116c145286790a7be7/templates/image_anima_base_v1.json#L679-L894).

### Hybrid

Tags and prose may be mixed in any order. The card specifically demonstrates quality and artist tags before a prose sentence:

```text
masterpiece, best quality, @artist name. An anime girl with medium-length blonde hair is...
```

That is the cleanest default because the control tags remain easy to audit while prose can bind attributes and actions more clearly. The accepted mixture and example are official; choosing it as the default is this guide's recommendation. See [Natural language prompting tips](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#natural-language-prompting-tips).

## Exact tags and prefixes

These are caption tags learned during training, not API keywords with validation.

- Human quality tags: `masterpiece`, `best quality`, `good quality`, `normal quality`, `low quality`, `worst quality`.
- Aesthetic-score tags: `score_9`, `score_8`, `score_7`, `score_6`, `score_5`, `score_4`, `score_3`, `score_2`, `score_1`.
- Year tags: `year 2025`, `year 2024`, and the same `year NNNN` form for a specific year.
- Period tags: `newest`, `recent`, `mid`, `early`, `old`.
- Safety tags: `safe`, `sensitive`, `nsfw`, `explicit`.
- Documented meta-tag examples: `highres`, `absurdres`, `anime screenshot`, `jpeg artifacts`, `official art`.
- Artist syntax: `@` immediately before the artist tag, for example `@big chungus`. The card says the effect is very weak without `@`.

The official lists and artist rule are in [Quality tags through Artist tags](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#quality-tags). Quality tags, score tags, both groups, or neither are accepted for Base. For Aesthetic, omit every `score_*` tag from both prompts. The fine-tune removed quality tags from its training captions, so quality tags are unnecessary; `masterpiece, best quality` is merely safe to leave in. See [Aesthetic version prompting](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#aesthetic-version-prompting).

For non-anime data styles, two dataset prefixes are documented. Put exactly `ye-pop` or `deviantart` at the very beginning, then a newline. An optional second line may hold ye-pop alt text or the DeviantArt work title, followed by the description. These prefixes describe the two extra training datasets. They are not general quality boosters. See [Dataset tags](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#dataset-tags).

```text
deviantart
Flame
Digital painting of a fiery dragon with glowing yellow eyes, black horns, and a long, sinuous tail, perched on glowing molten rock.
```

An older official comparison workflow contains the string `You are an assistant designed to generate anime images based on textual prompts. <Prompt Start>`, but its graph routes that prefix to the Lumina branch. The Anima Qwen branch receives the raw positive and negative strings. Do not add that sentence to Anima prompts. The routing is visible in the [official comparison workflow](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/anima_comparison.json).

## Weighting

The only Anima-specific weighting syntax documented by CircleStone is the ComfyUI form `(text:weight)`, with `(chibi:2)` as the example. The card warns that Anima needs a higher weight than SDXL usually does. It does not document nested parentheses such as `(((chibi)))` as an Anima convention. See [Prompting](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#prompting).

ComfyUI's implementation explains why weighting is unusual. It tokenizes the same input with a Qwen tokenizer and a T5 tokenizer, forces all Qwen token weights to `1.0`, and retains the T5-side weights. See [`AnimaTokenizer.tokenize_with_weights`](https://github.com/Comfy-Org/ComfyUI/blob/0301ccf745d24f41abdf05ba84ffb61a26ddaff7/comfy/text_encoders/anima.py#L8-L51). The model then feeds Qwen hidden states and the T5 token IDs through Anima's learned LLM adapter and multiplies the adapter output by those T5-side weights. See [`Anima.preprocess_text_embeds`](https://github.com/Comfy-Org/ComfyUI/blob/0301ccf745d24f41abdf05ba84ffb61a26ddaff7/comfy/ldm/anima/model.py#L196-L214).

## What the text encoder receives

The official Base workflow exposes `positive_prompt` and `negative_prompt`, but they are conditioning roles, not fields for two different encoders. One `CLIPLoader` loads `qwen_3_06b_base.safetensors`; its output connects to both the positive and negative `CLIPTextEncode` nodes. Each node receives its corresponding raw text. See the [loader and graph links in the pinned workflow](https://github.com/Comfy-Org/workflow_templates/blob/12199d938df3c531853036116c145286790a7be7/templates/image_anima_base_v1.json#L455-L500) and [the two encoder nodes](https://github.com/Comfy-Org/workflow_templates/blob/12199d938df3c531853036116c145286790a7be7/templates/image_anima_base_v1.json#L679-L894).

Internally, ComfyUI calls the loaded model Qwen3-0.6B but uses `Qwen2Tokenizer` with the bundled Qwen 2.5 tokenizer files. It also tokenizes the same string with a T5 tokenizer to produce IDs and weights for the learned adapter. There is no separately loaded T5 text-encoder checkpoint in this workflow. This is implementation-derived, not a model-card prompting instruction. See [`Qwen3Tokenizer` and `AnimaTokenizer`](https://github.com/Comfy-Org/ComfyUI/blob/0301ccf745d24f41abdf05ba84ffb61a26ddaff7/comfy/text_encoders/anima.py#L1-L51) and the [workflow's one text-encoder model](https://github.com/Comfy-Org/workflow_templates/blob/12199d938df3c531853036116c145286790a7be7/templates/image_anima_base_v1.json#L455-L500).

## Negative prompts

For Base and Turbo, the exact model-card recommendation is:

```text
worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration
```

The official current Base workflow uses a close variant and adds `sepia`:

```text
worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia
```

The first is the author's general recommendation in [Prompting](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#prompting). The second is one first-party sample in the [ComfyUI workflow](https://github.com/Comfy-Org/workflow_templates/blob/12199d938df3c531853036116c145286790a7be7/templates/image_anima_base_v1.json#L679-L734), not a universal replacement. For Aesthetic, remove all `score_*` items from positive and negative prompts as the card directs.

Safety belongs in positive conditioning too. The card's default positive prefix includes `safe`, and its limitations say short or underspecified prompts may produce unwanted content. Use the appropriate safety tag and give enough detail. See [Prompting](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#prompting) and [Limitations](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#limitations).

## Recommended default recipe

This recipe is a synthesis of the official rules, not a first-party preset.

1. Start with Turbo for iteration. Use 8 to 12 steps and CFG 1. Use Base or Aesthetic when diversity or style control matters more, at 30 to 50 steps and CFG 4 to 5.
2. For Base or Turbo, begin the positive prompt with `masterpiece, best quality, score_7, safe, `. For Aesthetic, use `safe, ` or at most `masterpiece, best quality, safe, ` and omit score tags everywhere.
3. Add the subject count, character and series if applicable, then an `@artist` tag only when intentionally requesting that artist tag.
4. Use enough concrete prose to describe each subject's appearance, position, action, setting, viewpoint, and light. Two sentences are a useful starting point, not a maximum.
5. Start with the model-card negative prompt. On Aesthetic, remove `score_1`, `score_2`, and `score_3`. Add scene-specific exclusions only when an observed failure calls for them.
6. Use `(trait:2)` only for a detail that needs emphasis. Do not mechanically carry nested-parenthesis weights from another model.

## Copyable examples

These examples are original recipes constrained to the official syntax. They are not claimed as tested outputs.

### Tag-only

```text
masterpiece, best quality, score_7, year 2025, newest, highres, safe, 1girl, solo, full body, red hair, green eyes, travel cloak, standing, forest path, wind, leaves, looking at viewer, sunset, rim light
```

Negative:

```text
worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration
```

### Prose-only

```text
A full-body anime illustration shows a red-haired traveler with green eyes standing on a forest path in a weathered cloak. Wind lifts her hair and loose leaves while sunset rim light outlines her figure, and she looks directly toward the viewer.
```

Negative:

```text
worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration
```

### Hybrid

```text
masterpiece, best quality, score_7, year 2025, safe, 2girls. A tall red-haired traveler in a weathered green cloak stands on the left and holds a brass lantern. A shorter black-haired mage in a blue coat stands on the right and studies a folded map; both are shown full-body on a rainy forest path under warm lantern light.
```

Negative:

```text
worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration, extra people
```

## NQ audit, 2026-09-04

Rechecked on 2026-09-04 against the current source and installed model filenames. NQ now uses `anima-turbo-v1.1-Q8_0.gguf`, the Qwen 0.6B encoder, and Qwen Image VAE through `sd-cli`. [`generateIllustrationPng`](../../src/play/illustration.ts) uses Euler, 8 steps, CFG 1, and 1344 by 768 output. These settings match the author's Turbo guidance. Four distinct seeds provide output variants. Installed identity was checked by path, not by rehashing the model.

The following findings describe the guide and defaults before the 2026-09-05 revision recorded below.

- [`illustration_guide.md`](../../src/play/illustration_guide.md) already requests hybrid prompts, tags with spaces, and per-character appearance descriptions. Keep those as useful application defaults, not model requirements.
- The guide's blanket "Earlier tags hit harder" is unsupported by the [official tag-order guidance](https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/README.md#tag-order), which allows arbitrary order within sections. `year 2025` is optional. The author recommends at least two sentences for pure prose, not a maximum of two for every prompt.
- The guide permits only cowboy shots or full-body shots. That is NQ policy, not an Anima limitation. The [first-party Base workflow](https://github.com/Comfy-Org/workflow_templates/blob/785127914ff0f5bddb38c5fbe20c96912e564d9b/templates/image_anima_base_v1.json#L840-L894) demonstrates a front portrait. Framing should follow the scene's purpose.
- Mandatory emotions, repeated wounds, automatic `(trait:2)` weights, and the claim that POV without hands collapses to a face are application heuristics without support in the examined official guidance. Weighting is supported; universal double weighting is not established. Test these choices on the actual backend before treating them as rules.
- The default negative contains the official quality exclusions plus fixed content and composition exclusions, including `close-up`, `portrait`, and `3girls`. Those composition exclusions conflict with some otherwise valid scenes. The backend's actual use of negative conditioning at CFG 1 was not verified in this research, so their visual effect is not established.
- The isolated prompt-writing session starts with the latest GM reply, player sheet, and live dossier catalog. It can retrieve more through tools, but it does not initially receive the preceding player action or whole conversation. Selecting one visible instant and recovering necessary action context are more useful instructions than automatically preferring a lone figure.
- `parseIllustrationPrompt` imposes a 2,400-character guard and format heuristics. This is an NQ constraint, not an official Anima token limit. The automatic model picker is not variant-aware; switching to Aesthetic would require revisiting both score tags and generation settings.

No image A/B experiment was performed for this recheck. Existing historical image tests above remain separate evidence. For a follow-on comparison, hold the checkpoint, seed set, resolution, and sampler fixed; change one prompt decision at a time and compare character identity, visible action, composition, and unwanted additions.

## NQ prompt revision, 2026-09-05

The revised [`illustration_guide.md`](../../src/play/illustration_guide.md) keeps hybrid prompting as an application default, removes the single-figure preference, and lets the scene determine cast and framing. It requests one visible instant, per-character appearance/action binding, and retrieval of missing context. It removes mandatory year tags, the two-sentence ceiling, forced emotions, repeated wounds, automatic trait weights, and compulsory POV hands/gender tags.

The renderer's fixed negative prompt no longer excludes close-ups, portraits, face focus, twins, siblings, sisters, clones, identical figures, extra girls, or three girls. The existing quality, underage-content, mixed-hair, and swapped-outfit exclusions remain. Model selection, sampler settings, scene inputs, and parser behavior are unchanged.

A live prompt-only smoke check used the configured text model through the production isolated looker and parser with disposable Campaign data. It preserved three distinct women jointly lifting a beam, produced a close-up of a guard through a shutter, and described an empty salt-mill environment without adding people. All three outputs passed the production parser and used unweighted descriptions. This verifies generated prompt text, not Anima image adherence; no diffusion renders or image A/B comparisons were performed.

## Checkpoint switch to WAI Nova Anima, 2026-10-01

NQ now renders with **WAI Nova Anima Turbo v1.0** (OGMustard, [Civitai version `3221297`](https://civitai.com/api/v1/model-versions/3221297)), a WAI-based Anima merge with the Turbo LoRA baked in. The published file is a 5.24 GB bf16 ComfyUI all-in-one checkpoint (SHA-256 `72b70b07…9fd55b`). Its bundled Qwen3 0.6B encoder is bit-identical to `qwen_3_06b_base`, and its VAE has the same values as `qwen_image_vae` (52 tensors stored as f16). `sd-cli -m` rejects the file because it does not map the bundled encoder's tensor names, so only the 685 `model.diffusion_model.*` tensors were extracted and converted with `sd-cli -M convert --type q8_0` to `wai-nova-anima-turbo-v1.0-Q8_0.gguf` (2.24 GB, SHA-256 `f882d0b9…172b7e`). NQ's generator arguments are unchanged: Euler, 8 steps, CFG 1, 1344 by 768.

The comparison held four guide prompts and seed `1234567` fixed across Turbo v1.1 Q8, DaSiWa Anima Obsidian Archives v2 plus the Turbo-ANIMA v4 LoRA (8 and 12 steps), DaSiWa alone (40 steps, CFG 4.5), and WAI Nova bf16. Sampling time was the same for Turbo v1.1 Q8 and WAI Nova Q8 when run back to back. WAI Nova gave the cleanest anime rendering and the best scene adherence: the dwarf pointed to the map, and only WAI Nova drew a multi-arch aqueduct with rubble beneath the central arch. DaSiWa was softer and glossier, with more uniform faces. One regression applies to both community checkpoints: in the guide's POV cup handover, they posed the elf holding the cup with both hands while the viewer's hands hovered beside it. Turbo v1.1 drew the handover. Q8 and bf16 WAI Nova renders matched closely. The explicit-content comparison was left to the user's own review.

The previous model, the trial checkpoints, and the comparison images were deleted in the 2026-10-01 cleanup; Turbo v1.1 Q8 can be re-downloaded if needed. NQ picks the first `anima` GGUF alphabetically, so only one diffusion GGUF may sit in the Anima folder. WAI Nova inherits Anima's CircleStone Labs Non-Commercial License.

## Evidence boundary and caveats

Everything labeled official above comes from the CircleStone model repository, ComfyUI source, or Comfy Org workflows. The default recipe, copyable examples, and migration suggestions are reasoned applications of those sources and have not been image-tested here. No community-only syntax is presented as fact.

The official card does not document the v1.1 checkpoint deltas, a special v1.1 prompt grammar, scoped character-tag grouping, nested-parenthesis semantics, or a separate prompt for a second text encoder. Treat claims about those topics from community prompt guides as unsupported until CircleStone documents them or a controlled image comparison establishes them.

Research snapshot: CircleStone Hugging Face revision [`f973fc41ec7545364ac9776c2440285f43ff2a30`](https://huggingface.co/circlestone-labs/Anima/commit/f973fc41ec7545364ac9776c2440285f43ff2a30), including Turbo v1.1, plus ComfyUI Anima encoder source at [`0301ccf745d24f41abdf05ba84ffb61a26ddaff7`](https://github.com/Comfy-Org/ComfyUI/tree/0301ccf745d24f41abdf05ba84ffb61a26ddaff7/comfy/text_encoders) and the first-party Base workflow at [`12199d938df3c531853036116c145286790a7be7`](https://github.com/Comfy-Org/workflow_templates/blob/12199d938df3c531853036116c145286790a7be7/templates/image_anima_base_v1.json).
