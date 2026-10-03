#!/usr/bin/env bash
# Start SuperQwen AgentWorld 35B-A3B Q4_K_M on the Atomic TurboQuant fork.
# --fit chooses GPU layers while preserving the requested 65,536-token context.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LLAMA_ROOT="${AGENTWORLD_LLAMA_ROOT:-$ROOT/llama.cpp.atomic}"
BIN="${AGENTWORLD_BIN:-$LLAMA_ROOT/build-cuda/bin/llama-server}"
MODEL="${AGENTWORLD_MODEL:-$ROOT/models/agentworld-35b/SuperQwen-AgentWorld-35B-A3B-abliterated-Q4_K_M.gguf}"
MTP_MODEL="${AGENTWORLD_MTP_MODEL:-$ROOT/models/agentworld-35b/mtp-Q4_K_M.gguf}"
CHAT_TEMPLATE="${AGENTWORLD_CHAT_TEMPLATE:-$ROOT/models/agentworld-35b/chat_template.jinja}"
HOST="${AGENTWORLD_HOST:-127.0.0.1}"
PORT="${AGENTWORLD_PORT:-8080}"
CTX="${AGENTWORLD_CTX:-65536}"
FIT_TARGET="${AGENTWORLD_FIT_TARGET:-100}"
CTK="${AGENTWORLD_CTK:-turbo3}"
CTV="${AGENTWORLD_CTV:-turbo3}"
ALIAS="${AGENTWORLD_ALIAS:-superqwen-agentworld-35b-a3b-q4km}"
SPEC_DRAFT_N_MAX="${AGENTWORLD_SPEC_DRAFT_N_MAX:-2}"
TEMP="${AGENTWORLD_TEMP:-1.0}"
TOP_P="${AGENTWORLD_TOP_P:-0.95}"
TOP_K="${AGENTWORLD_TOP_K:-20}"
MIN_P="${AGENTWORLD_MIN_P:-0.0}"
PRESENCE_PENALTY="${AGENTWORLD_PRESENCE_PENALTY:-0.0}"
REPEAT_PENALTY="${AGENTWORLD_REPEAT_PENALTY:-1.0}"
DRY_MULTIPLIER="${AGENTWORLD_DRY_MULTIPLIER:-0.8}"
DRY_BASE="${AGENTWORLD_DRY_BASE:-1.75}"
DRY_ALLOWED_LENGTH="${AGENTWORLD_DRY_ALLOWED_LENGTH:-2}"
DRY_PENALTY_LAST_N="${AGENTWORLD_DRY_PENALTY_LAST_N:-4096}"

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
  echo "missing MTP model: $MTP_MODEL" >&2
  exit 1
fi

if [[ ! -f "$CHAT_TEMPLATE" ]]; then
  echo "missing chat template: $CHAT_TEMPLATE" >&2
  exit 1
fi

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
  --temp "$TEMP" \
  --top-p "$TOP_P" \
  --top-k "$TOP_K" \
  --min-p "$MIN_P" \
  --presence-penalty "$PRESENCE_PENALTY" \
  --repeat-penalty "$REPEAT_PENALTY" \
  --dry-multiplier "$DRY_MULTIPLIER" \
  --dry-base "$DRY_BASE" \
  --dry-allowed-length "$DRY_ALLOWED_LENGTH" \
  --dry-penalty-last-n "$DRY_PENALTY_LAST_N" \
  --chat-template-file "$CHAT_TEMPLATE" \
  --reasoning on \
  --reasoning-format deepseek \
  --reasoning-preserve \
  --jinja \
  -a "$ALIAS" \
  "$@"
