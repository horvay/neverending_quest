#!/usr/bin/env bash
# Start Ternary-Bonsai (heretic-ja Q2_g64) for NQ local play.
# Default binary: Atomic TurboQuant fork (Q2_0 g64 + wire-id 42→47 remap).
# KV: K = q8_0; V = turbo3 (TurboQuant).
# Context: auto-fit unless BONSAI_CTX is a positive int.
# Thinking: on by default (Qwen3.6/Bonsai); NQ strips reasoning from player prose.
set -euo pipefail

ROOT="${BONSAI_ROOT:-$HOME/src/atomic-llama-cpp-turboquant}"
BIN="${BONSAI_BIN:-$ROOT/build/bin/llama-server}"
MODEL="${BONSAI_MODEL:-$HOME/models/ternary-bonsai-27b-heretic-ja/Ternary-Bonsai-27B-heretic-ja-Q2_g64.gguf}"
HOST="${BONSAI_HOST:-127.0.0.1}"
PORT="${BONSAI_PORT:-8080}"
CTX="${BONSAI_CTX:-}"
NGL="${BONSAI_NGL:-99}"
ALIAS="${BONSAI_ALIAS:-ternary-bonsai-27b-heretic-ja}"
CTK="${BONSAI_CTK:-q8_0}"
CTV="${BONSAI_CTV:-turbo3}"
FIT_TARGET="${BONSAI_FIT_TARGET:-1024}"
FIT_CTX_MIN="${BONSAI_FIT_CTX:-4096}"

# Bonsai 27B card / demo sampling (thinking-mode benchmarks).
TEMP="${BONSAI_TEMP:-0.7}"
TOP_P="${BONSAI_TOP_P:-0.95}"
TOP_K="${BONSAI_TOP_K:-20}"
MIN_P="${BONSAI_MIN_P:-0}"

# DRY sampler (anti-repetition).
DRY_MULT="${BONSAI_DRY_MULTIPLIER:-0.8}"
DRY_BASE="${BONSAI_DRY_BASE:-1.75}"
DRY_ALLOWED="${BONSAI_DRY_ALLOWED_LENGTH:-2}"
DRY_LAST_N="${BONSAI_DRY_PENALTY_LAST_N:-4096}"

# Thinking: on | off | auto. Budget -1 unlimited, 0 = immediate end, N = cap.
REASONING="${BONSAI_REASONING:-on}"
REASONING_BUDGET="${BONSAI_REASONING_BUDGET:-512}"
REASONING_FORMAT="${BONSAI_REASONING_FORMAT:-deepseek}"  # reasoning_content separate from content

if [[ ! -x "$BIN" ]]; then
  echo "missing llama-server: $BIN" >&2
  echo "build: cmake -S $ROOT -B $ROOT/build -DGGML_CUDA=ON && cmake --build $ROOT/build -j --target llama-server" >&2
  exit 1
fi
if [[ ! -f "$MODEL" ]]; then
  echo "missing model: $MODEL" >&2
  echo "download: hf download Hikari07jp/Ternary-Bonsai-27B-Abliterated-LowDeg-GGUF Ternary-Bonsai-27B-Abliterated-LowDeg-Q2_0.gguf --local-dir $(dirname "$MODEL")" >&2
  exit 1
fi

args=(
  -m "$MODEL"
  --host "$HOST"
  --port "$PORT"
  -ngl "$NGL"
  -np 1
  -fa on
  --jinja
  --temp "$TEMP"
  --top-p "$TOP_P"
  --top-k "$TOP_K"
  --min-p "$MIN_P"
  --dry-multiplier "$DRY_MULT"
  --dry-base "$DRY_BASE"
  --dry-allowed-length "$DRY_ALLOWED"
  --dry-penalty-last-n "$DRY_LAST_N"
  --reasoning "$REASONING"
  --reasoning-format "$REASONING_FORMAT"
  --reasoning-budget "$REASONING_BUDGET"
  -ctk "$CTK"
  -ctv "$CTV"
  -a "$ALIAS"
)

if [[ -n "$CTX" && "$CTX" != "0" ]]; then
  args+=(-c "$CTX" --fit off)
  echo "context: fixed -c $CTX" >&2
else
  args+=(--fit on --fit-target "$FIT_TARGET" --fit-ctx "$FIT_CTX_MIN")
  echo "context: auto (--fit on, target ${FIT_TARGET}MiB free, min ctx ${FIT_CTX_MIN})" >&2
fi

echo "thinking: --reasoning $REASONING budget=$REASONING_BUDGET format=$REASONING_FORMAT" >&2
echo "sampling: temp=$TEMP top_p=$TOP_P top_k=$TOP_K min_p=$MIN_P" >&2
echo "dry: mult=$DRY_MULT base=$DRY_BASE allowed=$DRY_ALLOWED last_n=$DRY_LAST_N" >&2

exec "$BIN" "${args[@]}" "$@"
