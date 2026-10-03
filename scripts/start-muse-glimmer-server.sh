#!/usr/bin/env bash
# Start Muse-Glimmer-30B heretic i1 Q4_K_M on ggml-org llama.cpp (b10353+).
# Official run path: --jinja, temp 1.0 / top_p 0.95 / top_k 64.
# Do NOT pass --reasoning-format deepseek. Thinking splits into reasoning_content by default.
# reasoning_strength is a template kwarg (low|medium|high|xhigh); thinking cannot be turned off.
# --fit is used because a 12GB card cannot hold 17GB weights + 64k KV at -ngl 99.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LLAMA_ROOT="${MUSE_LLAMA_ROOT:-$ROOT/llama.cpp}"
BIN="${MUSE_BIN:-$LLAMA_ROOT/build/bin/llama-server}"
MODEL="${MUSE_MODEL:-$ROOT/models/muse-glimmer/Muse-Glimmer-30B-heretic.i1-Q4_K_M.gguf}"
HOST="${MUSE_HOST:-127.0.0.1}"
PORT="${MUSE_PORT:-8080}"
CTX="${MUSE_CTX:-}"
NGL="${MUSE_NGL:-}"
ALIAS="${MUSE_ALIAS:-muse-glimmer}"
# Official llama.cpp has no turbo3. Leave empty to use server defaults, or set e.g. q8_0.
CTK="${MUSE_CTK:-}"
CTV="${MUSE_CTV:-}"
FIT_TARGET="${MUSE_FIT_TARGET:-2048}"
FIT_CTX_MIN="${MUSE_FIT_CTX:-65536}"

TEMP="${MUSE_TEMP:-1.0}"
TOP_P="${MUSE_TOP_P:-0.95}"
TOP_K="${MUSE_TOP_K:-64}"
MIN_P="${MUSE_MIN_P:-0}"

REASONING_STRENGTH="${MUSE_REASONING_STRENGTH:-low}"

if [[ ! -x "$BIN" ]]; then
  echo "missing llama-server: $BIN" >&2
  echo "need ggml-org/llama.cpp b10353+ with Muse Glimmer. build:" >&2
  echo "  cmake -S $LLAMA_ROOT -B $LLAMA_ROOT/build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DCMAKE_CUDA_ARCHITECTURES=86" >&2
  echo "  cmake --build $LLAMA_ROOT/build -j --target llama-server" >&2
  exit 1
fi
if [[ ! -f "$MODEL" ]]; then
  echo "missing model: $MODEL" >&2
  echo "missing: Muse-Glimmer-30B-heretic.i1-Q4_K_M.gguf in $(dirname "$MODEL")" >&2
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
  --chat-template-kwargs "{\"reasoning_strength\":\"$REASONING_STRENGTH\"}"
  -a "$ALIAS"
)

if [[ -n "$CTK" ]]; then
  args+=(-ctk "$CTK")
fi
if [[ -n "$CTV" ]]; then
  args+=(-ctv "$CTV")
fi

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

echo "kv: ctk=${CTK:-default} ctv=${CTV:-default}  ngl=${NGL:-fit}  alias=$ALIAS" >&2
echo "reasoning: strength=$REASONING_STRENGTH (no --reasoning-format; official default splits thinking)" >&2
echo "sampling: temp=$TEMP top_p=$TOP_P top_k=$TOP_K min_p=$MIN_P" >&2

exec "$BIN" "${args[@]}" "$@"
