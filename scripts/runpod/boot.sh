set -e
# Composed by scripts/runpod/deploy.ts, which writes the sealed worker bundle to
# /opt/seal/worker.mjs ahead of this script. Only the sealed worker listens on
# the public $PORT; llama-server stays on loopback and never sees the relay.
echo "[nq] boot $(date -u +%T) gpu=$(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader)"
ROOT=/runpod-volume; [ -d "$ROOT" ] || ROOT=/opt/nq

# fetch a tarball once into the volume cache
cached() {
  if [ ! -e "$1/$3" ]; then
    rm -rf "$1.tmp"; mkdir -p "$1.tmp"
    curl -fsSL "$2" | tar xz --no-same-owner -C "$1.tmp" $4
    rm -rf "$1"; mv "$1.tmp" "$1"
  fi
}
RT="$ROOT/atomic/$(basename "$(dirname "$ATOMIC_URL")")"
cached "$RT" "$ATOMIC_URL" build/bin/llama-server
NODE="$ROOT/node/$(basename "$NODE_URL" .tar.gz)"
cached "$NODE" "$NODE_URL" bin/node --strip-components=1
echo "[nq] runtimes ready $(date -u +%T)"

# the sealed worker answers /ping with 204 until llama-server is healthy
NQ_SEAL_WORKER_MAIN=1 NQ_SEAL_UPSTREAM=http://127.0.0.1:8081 \
  "$NODE/bin/node" /opt/seal/worker.mjs &

MODEL="$ROOT/models/$(basename "$MODEL_URL")"
# the volume holds one model at a time: drop any other before fetching this one
mkdir -p "$ROOT/models"
find "$ROOT/models" -maxdepth 1 -type f \( -name '*.gguf' -o -name '*.gguf.part' \) \
  ! -name "$(basename "$MODEL")" ! -name "$(basename "$MODEL").part" -print -delete
if [ ! -f "$MODEL" ]; then
  curl -fL --retry 5 --retry-delay 3 -sS -C - -o "$MODEL.part" "$MODEL_URL"
  mv "$MODEL.part" "$MODEL"
fi
echo "[nq] model ready $(date -u +%T) $(du -h "$MODEL" | cut -f1)"
export LD_LIBRARY_PATH="$RT/build/bin:$LD_LIBRARY_PATH"
# EXTRA_ARGS="-lm dio": direct I/O reads the network volume in ~12-20s where
# the default mmap takes 23-40s; FlashBoot resumes keep the model loaded anyway.
"$RT/build/bin/llama-server" -m "$MODEL" --host 127.0.0.1 --port 8081 \
  -np 1 -c "$CTX" -fa on -ctk "$CACHE_K" -ctv "$CACHE_V" -ngl 999 --jinja \
  -a "$ALIAS" --reasoning-budget "$REASONING" $EXTRA_ARGS &

# either process dying takes the container down, so Runpod replaces it
wait -n
exit 1
