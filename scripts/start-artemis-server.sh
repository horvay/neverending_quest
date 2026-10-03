#!/usr/bin/env bash
# Start Artemis-31B-v1.1 IQ3_XXS (Gemma 4, bartowski) on Atomic TurboQuant llama-server.
# KV: turbo3/turbo3. Floor context 65536 via --fit (31B Q4 will not fully GPU-fit).
# Template: Gemma 4 + jinja. Thinking off by default (override MUSE_REASONING=on).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LLAMA_ROOT="${ARTEMIS_LLAMA_ROOT:-$ROOT/llama.cpp}"
BIN="${ARTEMIS_BIN:-$LLAMA_ROOT/build/bin/llama-server}"
MODEL="${ARTEMIS_MODEL:-$ROOT/models/artemis/TheDrummer_Artemis-31B-v1.1-IQ3_XXS.gguf}"
HOST="${ARTEMIS_HOST:-127.0.0.1}"
PORT="${ARTEMIS_PORT:-8080}"
CTX="${ARTEMIS_CTX:-}"
NGL="${ARTEMIS_NGL:-}"
ALIAS="${ARTEMIS_ALIAS:-artemis-31b}"
CTK="${ARTEMIS_CTK:-turbo3}"
CTV="${ARTEMIS_CTV:-turbo3}"
# Leave headroom for CUDA compute buffers at 64k. fit-target 0 OOMs on 12GB.
FIT_TARGET="${ARTEMIS_FIT_TARGET:-2048}"
FIT_CTX_MIN="${ARTEMIS_FIT_CTX:-65536}"

TEMP="${ARTEMIS_TEMP:-0.5}"
TOP_P="${ARTEMIS_TOP_P:-0.95}"
TOP_K="${ARTEMIS_TOP_K:-64}"
MIN_P="${ARTEMIS_MIN_P:-0.05}"

REASONING="${ARTEMIS_REASONING:-off}"
REASONING_FORMAT="${ARTEMIS_REASONING_FORMAT:-deepseek}"

if [[ ! -x "$BIN" ]]; then
  echo "missing llama-server: $BIN" >&2
  echo "build: cmake -S $LLAMA_ROOT -B $LLAMA_ROOT/build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_UI=OFF && cmake --build $LLAMA_ROOT/build -j --target llama-server" >&2
  exit 1
fi
if [[ ! -f "$MODEL" ]]; then
  echo "missing model: $MODEL" >&2
  echo "download: hf download bartowski/TheDrummer_Artemis-31B-v1.1-GGUF TheDrummer_Artemis-31B-v1.1-IQ3_XXS.gguf --local-dir $(dirname "$MODEL")" >&2
  exit 1
fi

args=(
  -m "$MODEL"
  --host "$HOST"
  --port "$PORT"
  -np 1
  -fa on
  --jinja
  --temp "$TEMP"
  --top-p "$TOP_P"
  --top-k "$TOP_K"
  --min-p "$MIN_P"
  --reasoning "$REASONING"
  --reasoning-format "$REASONING_FORMAT"
  -ctk "$CTK"
  -ctv "$CTV"
  -a "$ALIAS"
)

if [[ -n "$NGL" ]]; then
  args+=(-ngl "$NGL")
fi

if [[ -n "$CTX" && "$CTX" != "0" ]]; then
  args+=(-c "$CTX" --fit off)
  [[ -z "$NGL" ]] && args+=(-ngl 99)
  echo "context: fixed -c $CTX" >&2
else
  args+=(--fit on --fit-target "$FIT_TARGET" --fit-ctx "$FIT_CTX_MIN")
  echo "context: auto (--fit on, target ${FIT_TARGET}MiB free, min ctx ${FIT_CTX_MIN})" >&2
fi

echo "kv: -ctk $CTK -ctv $CTV  ngl=${NGL:-fit}  alias=$ALIAS  reasoning=$REASONING" >&2
echo "sampling: temp=$TEMP top_p=$TOP_P top_k=$TOP_K min_p=$MIN_P" >&2

exec "$BIN" "${args[@]}" "$@"
