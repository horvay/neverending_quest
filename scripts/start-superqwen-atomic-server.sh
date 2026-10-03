#!/usr/bin/env bash
# Start SuperQwen3.8 27B abliterated IQ3_M on the Atomic TurboQuant fork.
# The model is larger than the RTX 3080 Ti VRAM, so --fit chooses GPU layers
# while preserving the explicitly requested 65,536-token context.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LLAMA_ROOT="${SUPERQWEN_LLAMA_ROOT:-$ROOT/llama.cpp.atomic}"
BIN="${SUPERQWEN_BIN:-$LLAMA_ROOT/build-cuda/bin/llama-server}"
MODEL="${SUPERQWEN_MODEL:-$ROOT/models/superqwen-27b/SuperQwen3.8-27b-abliterated.i1-IQ3_M.gguf}"
MTP_MODEL="${SUPERQWEN_MTP_MODEL:-$ROOT/models/superqwen-27b/mtp-Qwen3.8-27B-Q4_0.gguf}"
HOST="${SUPERQWEN_HOST:-127.0.0.1}"
PORT="${SUPERQWEN_PORT:-8080}"
CTX="${SUPERQWEN_CTX:-65536}"
FIT_TARGET="${SUPERQWEN_FIT_TARGET:-100}"
CTK="${SUPERQWEN_CTK:-turbo3}"
CTV="${SUPERQWEN_CTV:-turbo3}"
ALIAS="${SUPERQWEN_ALIAS:-superqwen-27b-iq3m}"
SPEC_DRAFT_N_MAX="${SUPERQWEN_SPEC_DRAFT_N_MAX:-2}"

if [[ ! -x "$BIN" ]]; then
  echo "missing Atomic llama-server: $BIN" >&2
  echo "build it with:" >&2
  echo "  cmake -S $LLAMA_ROOT -B $LLAMA_ROOT/build-cuda -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_UI=ON -DLLAMA_USE_PREBUILT_UI=OFF -DCMAKE_CUDA_ARCHITECTURES=86" >&2
  echo "  cmake --build $LLAMA_ROOT/build-cuda -j --target llama-server" >&2
  exit 1
fi

if [[ ! -f "$MODEL" ]]; then
  echo "missing model: $MODEL" >&2
  exit 1
fi

if [[ ! -f "$MTP_MODEL" ]]; then
  echo "missing MTP head: $MTP_MODEL" >&2
  exit 1
fi

# Atomic automatically upgrades K from turbo3 to q8_0 on this model's 6:1 GQA
# ratio to avoid quality loss. V remains turbo3. Set TURBO_AUTO_ASYMMETRIC=0 only
# when deliberately testing the lower-quality all-turbo3 cache.
exec "$BIN" \
  -m "$MODEL" \
  --host "$HOST" \
  --port "$PORT" \
  -np 1 \
  -c "$CTX" \
  -fa on \
  -ctk "$CTK" \
  -ctv "$CTV" \
  --fit on \
  --fit-target "$FIT_TARGET" \
  -md "$MTP_MODEL" \
  --spec-type nextn \
  --spec-draft-n-max "$SPEC_DRAFT_N_MAX" \
  --spec-draft-n-min 1 \
  --jinja \
  -a "$ALIAS" \
  "$@"
