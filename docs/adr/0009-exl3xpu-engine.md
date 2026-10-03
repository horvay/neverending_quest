# EXL3 models run on exl3xpu beside Atomic

**This computer** has a second engine. A GGUF model runs on Atomic as before. An EXL3 model folder (exllamav3, `mul1` codebook) runs on **exl3xpu**: vLLM with the ESIMD kernels of [0xSero/exl3xpu](https://github.com/0xSero/exl3xpu), on an Intel Arc (Xe2) GPU. The model the player picks decides the engine; the Local Inference Host, the load page and the Campaign are shared.

**Why:** On an Arc Pro B70, Gemma 4 31B prefilled at ~2,000 tok/s on exl3xpu (4-bit EXL3, 3k–12k prompts) against ~1,100 on llama.cpp SYCL and ~330 → 34 (0 → 8k context) on Atomic's Vulkan build, and decoded ~33 tok/s with Google's assistant drafter against ~25. Intel's Vulkan driver offers only 8x16x16 cooperative-matrix tiles, which llama.cpp's flash attention cannot use well.

## Considered options

- **Docker image as published** — rejected; NQ must not need a daemon or root. NQ pulls the image's layers from the registry itself (pinned digest, SHA-256 per layer, OCI whiteouts), unpacks them under `~/.local/share/nq/local/engines/exl3xpu/` and runs vLLM in bubblewrap (`bwrap`, its own PID namespace, host network on 127.0.0.1).
- **llama.cpp SYCL** — kept as the reference; slower prefill on the B70 and a oneAPI runtime to ship.
- **Porting Intel's Xe flash-attention kernels into Atomic** — rejected for now; still behind plain attention at depth on Gemma 4.
- **Teaching NQ's Game Master a vLLM dialect** — rejected; the Local Inference Host translates instead, so the agent layer stays one shape.

## Consequences

- The host rewrites NQ's Atomic-shaped requests for exl3xpu: the thinking prefill (`continue_final_message: "reasoning_content"`) becomes `chat_template_kwargs.nq_prefill`, which a hook NQ appends to the model's chat template emits after the generation prompt; the reasoning budget becomes `thinking_token_budget`; `reasoning_control` is dropped, and so are `min_p`/`logit_bias` while a drafter is loaded (vLLM refuses them with speculative decoding).
- **Answer now** on exl3xpu is emulated: vLLM cannot change a request in flight, so the host aborts it and resends with the streamed thought closed, splicing the answer into the stream the Game Master is reading. The prefix cache makes the resend cheap.
- NQ patches two lines of the image's plugin for Gemma 4 (K=V attention layers; tied `lm_head`). An image whose plugin no longer matches fails the install rather than run unpatched.
- vLLM changes live in a fork, [horvay/vllm](https://github.com/horvay/vllm) branch `main`, based on the commit the image was built from. The install replaces the image's copies of the changed files with the fork's, fetched at a pinned commit and checked by SHA-256, and refuses an image whose copies are not upstream's base. `EXL3XPU_VLLM_FORK` pins them; `tests/fixtures/vllm-fork/` holds both versions. An engine at an older patch level is updated in place, without pulling the image again.
- Shared serving (several games at once, a RAM cache): the RAM tier is vLLM's lazy offloader, which moves blocks to RAM only as they are about to leave the card, given an Intel copy path in the fork. Sliding-window layers (Gemma 4: 50 of 60) cache only the tail a follow-up turn can reuse (`VLLM_PREFIX_CACHE_RETENTION_INTERVAL=0` plus the fork's replay slack); left at vLLM's default they cached every past window, which pushed other games' contexts off the card and filled RAM five times faster. The RAM cache is at most half the computer's RAM and pinned (a 30 GiB cache on 62 GiB crashed the `xe` driver's reclaim); on Intel it rounds down to a power of two.
- A drafter is found, not configured: an assistant model folder beside the model whose `backbone_hidden_size` and vocabulary match. Draft length is 2: with decode graphs it beat 3 for one game and matched it for eight. The drafter proposes from a pruned vocabulary (`gemma4_draft_vocab.json`, the ~11k tokens the model used in story turns); the target verifies with its full head, so output is unchanged.
- An Illustration no longer stops an exl3xpu Game Master: it runs on the Intel GPU, NQ's `sd-cli` builds are CUDA.
- The first start compiles for a few minutes (allowed 15). Decode steps replay captured XPU graphs (`FULL_DECODE_ONLY`, one size per game count). Capture used to fail inside Inductor for Gemma 4; the cause was a lazy `layer_scalar.item()` in the compiled forward, which the fork now reads at load. Graphs took one game from 28.9 to 38.4 tok/s and 19.5k-token context from 9.5 to 37.8.
- Intel's runtime runs with `TreatNonUsmForTransfersAsSharedSystem=0` and `EnableSharedSystemUsmSupport=0` (after 0xSero's omarchy-local-ai): host copies go through staging buffers, because the copy engine reading a swapped or unmapped page in place faulted the card while loading weights.
- An EXL3 model may carry its own quantized head (`tie_word_embeddings: false`); NQ then leaves `EXL3_TIED_LM_HEAD` off. A 6-bit head cut the 2.8 GB bf16 head read per step (about 4.7 ms on the B70) at +0.6% NLL.
- Only families NQ knows the parsers and thinking markers for are offered (Gemma 4 today).
