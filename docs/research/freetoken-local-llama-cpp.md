# FreeToken with NQ's local Atomic server

Investigated 2026-08-27 from FreeToken, Qwen, Atomic, and NQ first-party sources. FreeToken source claims below are pinned to revision `9ef3651` (package version 0.1.2) where compatibility matters. [Version source](https://github.com/FlashML-org/FreeToken/blob/9ef3651309fe4058672f2cc92069238dea06be1b/python/freetoken/version.py#L1)

## Direct answer

**FreeToken cannot be applied directly to the existing Qwen3.5-122B-A10B GGUF or enabled inside Atomic with a flag.** FreeToken is a separate serving engine. Its model documentation says it loads Hugging Face safetensors or FreeToken's FTW format; native GGUF is limited to Gemma 4. The loader maps only `general.architecture = gemma4` and rejects other GGUF architectures, so a Qwen GGUF is explicitly outside that path. Its known-good Qwen3.5 entry is 35B-A3B, not 122B-A10B, although the documentation says checkpoints of the same supported architectures may work. That is not an upstream compatibility claim for this exact checkpoint. [Format documentation](https://github.com/FlashML-org/FreeToken/blob/9ef3651309fe4058672f2cc92069238dea06be1b/docs/models.md#L1-L4), [GGUF architecture map](https://github.com/FlashML-org/FreeToken/blob/9ef3651309fe4058672f2cc92069238dea06be1b/python/freetoken/models/gguf/config.py#L18-L22), [unsupported-architecture error](https://github.com/FlashML-org/FreeToken/blob/9ef3651309fe4058672f2cc92069238dea06be1b/python/freetoken/models/gguf/config.py#L57-L64)

The official 122B-A10B repository is a Qwen3.5 MoE Transformers/safetensors checkpoint (122B total, 10B active, 256 experts, 8 routed plus 1 shared), so it has the kind of sparse expert structure FreeToken targets. The model card does not list FreeToken among its tested runtimes. [Qwen3.5-122B-A10B model card](https://huggingface.co/Qwen/Qwen3.5-122B-A10B)

A trial therefore requires a **parallel FreeToken deployment from the official HF checkpoint**, not reuse of the current GGUF. It should be treated as unvalidated until FreeToken successfully loads the exact checkpoint and produces correct text. Using the current GGUF would instead require implementing general Qwen GGUF loading and the relevant quantized kernels in FreeToken, or porting FreeToken's runtime mechanisms into Atomic/llama.cpp.

## Mechanisms are different

| Mechanism | FreeToken | NQ's Atomic path | Practical effect |
| --- | --- | --- | --- |
| MoE expert placement | Keeps the complete routed-expert pool in host RAM, non-expert weights on GPU, and a global LRU cache of `(layer, expert)` entries in spare VRAM. Cache misses are split between PCIe transfer/GPU execution and direct CPU execution using measured host and PCIe bandwidth. Prefill double-buffers whole expert layers. [FreeToken paper §§3.1–3.2](https://arxiv.org/html/2608.16157#S3) | llama.cpp assigns tensors/layers to devices at load time; NQ passes Atomic `--fit on` to select a static fit for the GGUF. [FreeToken comparison §2.2](https://arxiv.org/html/2608.16157#S2.SS2), [NQ launch arguments](../../packages/local-inference/src/runtime.ts#L408-L423) | FreeToken's prospective decode gain is expert-level dynamic caching and CPU/PCIe co-execution, not fewer model parameters. |
| Weight quantization | The documented Qwen path is HF safetensors/FTW, with formats such as BF16, FP8, and NVFP4; the known-good list does not include this model or Qwen GGUF. FTW is a fast-load repack, not a claim that weights become smaller. [README](https://github.com/FlashML-org/FreeToken#about), [model formats](https://github.com/FlashML-org/FreeToken/blob/main/docs/models.md), [checkpoint CLI](https://github.com/FlashML-org/FreeToken/blob/main/docs/cli.md#ft-checkpoint) | Atomic consumes the existing quantized GGUF and also supports TurboQuant weight formats. [Atomic weight compression](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant#turboquant--kv-cache--weight-compression) | FreeToken itself is not a new quantizer for this GGUF. Replacing a low-bit GGUF with BF16/FP8 safetensors could **increase** host-memory and disk requirements; only an equivalent supported low-bit checkpoint permits a fair comparison. |
| KV memory | Paged KV capacity is sized from VRAM left after weights/expert cache; expert and KV pools can be resized without reloading the host expert pool. [FreeToken CLI](https://github.com/FlashML-org/FreeToken/blob/main/docs/cli.md#kv-cache--memory), [paper §3.3](https://arxiv.org/html/2608.16157#S3.SS3) | NQ explicitly selects an asymmetric cache: `q8_0` for K and `turbo3` for V. Atomic documents about 4.3× KV compression versus F16 for turbo3. [NQ launch arguments](../../packages/local-inference/src/runtime.ts#L469-L486), [Atomic KV compression](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant#kv-cache-types--ctk--ctv) | FreeToken reallocates VRAM; that is not the same as compressing the KV cache. Its public CLI does not document a TurboQuant-equivalent compressed KV type, so it is not established as a KV-memory reduction over the current setup. |
| Speculative decoding | FreeToken's documented speed mechanisms are expert caching/offload, prefill overlap, prefix/state reuse, and bandwidth-adaptive execution. Its public serving CLI does not claim MTP/NextN speculative decoding. [FreeToken CLI](https://github.com/FlashML-org/FreeToken/blob/main/docs/cli.md#ft-serve), [paper design](https://arxiv.org/html/2608.16157#S3) | When an MTP GGUF is installed, NQ launches Atomic with a draft model and `--spec-type nextn`; Atomic documents NextN as speculative decoding. [NQ MTP arguments](../../packages/local-inference/src/runtime.ts#L424-L436), [Atomic Qwen NextN](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant#qwen-36-nextn--speculative-decoding) | FreeToken's claimed throughput should not be described as speculative decoding. Switching engines may forfeit Atomic's MTP acceleration unless FreeToken adds and validates equivalent support. |

## Memory and throughput conclusions

### RAM and VRAM

- **RAM: no inherent reduction.** FreeToken requires the complete routed-expert pool in host memory as its source of truth. It changes placement and scheduling; it does not remove expert weights. Actual RAM is governed mainly by the chosen checkpoint precision/layout. [FreeToken paper §3](https://arxiv.org/html/2608.16157#S3)
- **VRAM: bounded and more elastic, not necessarily lower than this Atomic configuration.** `--memory-ratio` caps FreeToken's weight + expert-cache + KV allocation and its cache can shrink, but non-expert weights remain GPU-resident and the exact 122B model has not been shown to fit a 12 GB GPU. [FreeToken CLI memory flags](https://github.com/FlashML-org/FreeToken/blob/main/docs/cli.md#kv-cache--memory)
- The workstation's RTX 30 family is named as supported, but FreeToken additionally requires Linux x86_64, an NVIDIA r580+ driver, CUDA 13, and `nvcc` for first-use JIT compilation. Hardware-family support does not establish model fit. [FreeToken install requirements](https://github.com/FlashML-org/FreeToken/blob/main/docs/install.md)

### Decode speed

There is credible evidence that FreeToken can improve MoE decode throughput, but **none for this exact 122B GGUF/workstation combination**. The paper reports that, for Qwen3.6-35B-A3B in BF16, FreeToken beat the strongest tested baseline by 1.3× on an RTX 3090 and by 1.3–2.1× across tested consumer systems. That experiment used an RTX 3090 with 24 GB VRAM, 180 GiB server RAM, dual Xeon CPUs, and aligned BF16 weights; it did not test an RTX 3080 Ti, Ryzen 5900XT, Atomic's fork, Qwen3.5-122B-A10B, GGUF quantization, turbo3 KV, or MTP. [FreeToken evaluation setup](https://arxiv.org/html/2608.16157#S5.SS1), [cross-hardware result](https://arxiv.org/html/2608.16157#S5.SS3)

Consequently, a speedup is plausible because 122B-A10B is MoE, but its size, expert-routing locality, checkpoint precision, host-RAM bandwidth, 12 GB VRAM, and loss of Atomic-specific TurboQuant/MTP paths can change the result. No source supports a numeric throughput prediction for this machine.

## Integration required

FreeToken exposes OpenAI-compatible `/v1/*` APIs and can bind a chosen host/port. NQ discovers local models through `GET /v1/models` at `127.0.0.1:8080`, so a manually started FreeToken server on port 8080 is a reasonable protocol-level experiment. [FreeToken CLI](https://github.com/FlashML-org/FreeToken/blob/main/docs/cli.md#ft-serve), [NQ local provider discovery](../../src/home/providers.ts#L5-L6), [NQ model listing](../../src/home/providers.ts#L136-L153)

That does not make it an NQ-managed Atomic installation. NQ's manager currently installs an Atomic `llama-server`, accepts GGUF sources, and launches Atomic-specific `--fit`, `turbo3`, and optional MTP flags. Production integration would require:

1. add FreeToken as a distinct local runtime/backend rather than a llama.cpp option;
2. resolve/download the official HF safetensors (or pre-convert them to FTW), with enough host RAM for the selected precision;
3. check the FreeToken driver/CUDA prerequisites and run `ft bench bw` on this machine;
4. launch `ft serve --model ... --port 8080` with an explicit VRAM/KV budget, then preserve NQ's OpenAI-compatible endpoint and model discovery contract;
5. add lifecycle/status/logging/uninstall handling without passing Atomic-only GGUF, TurboQuant, or MTP flags;
6. validate the exact checkpoint's load, text-only chat template/tool calls, long-context behavior, peak RAM/VRAM, TTFT, and decode tok/s against Atomic under the same prompts and effective precision.

## Recommendation

**Do not modify the current Atomic deployment or expect FreeToken to accelerate its GGUF in place.** First run an isolated feasibility benchmark using the official Qwen3.5-122B-A10B HF checkpoint only if a FreeToken-supported low-bit representation and sufficient host RAM are available. Compare end-to-end NQ turns, not a headline benchmark: peak RAM/VRAM, TTFT after tool-call context edits, steady decode tok/s, output correctness, and the current Atomic configuration with turbo3 KV and MTP where available.

Adopt FreeToken as an alternate managed runtime only if that exact trial loads correctly and beats Atomic materially without unacceptable memory or feature regressions. Otherwise, obtaining FreeToken's benefits while retaining the existing GGUF requires substantial engine work—general Qwen GGUF/quantized-kernel support in FreeToken or a port of its expert cache, prefill pipeline, and bandwidth-adaptive execution into Atomic—not an NQ configuration change.
