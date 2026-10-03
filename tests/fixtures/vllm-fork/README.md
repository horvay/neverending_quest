vLLM files (Apache-2.0, Copyright contributors to the vLLM project) that NQ's
exl3xpu install replaces: `base/` is upstream vllm-project/vllm at
568afb3a13806beb53bb2e6bd518269357b237c0 as the exl3xpu image ships it (its gemma4.py is
Intel's, from intel/llm-scaler-vllm),
`fork/` is github.com/horvay/vllm at 49eb1dbe80d234ebc7f4a9fd82493ab3a27c311d, and
`previous/` holds earlier fork versions an installed engine may still carry.
The fake registry and fake GitHub in tests/helpers/exl3_registry.ts serve them,
so tests check EXL3XPU_VLLM_FORK's pinned hashes against the real files.
Refresh both folders whenever EXL3XPU_VLLM_FORK changes.
