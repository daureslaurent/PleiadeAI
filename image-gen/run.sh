#!/usr/bin/env bash
#
# run.sh — one-shot bootstrap for the GGUF image generation server.
#
#   ./run.sh              download FLUX.1-schnell GGUF weights (if missing), then start the server
#   ./run.sh models       download the model files only
#   ./run.sh up           start the server only (assumes models present)
#   ./run.sh down         stop the server
#   ./run.sh logs         follow server logs
#   ./run.sh test         POST a sample prompt to the running server and save the PNG
#
# Weights are pulled from Hugging Face into ./models. See .env.example to swap models.
# Defaults target FLUX.1-dev (GGUF via city96 — ungated; the VAE is pulled from an
# ungated schnell GGUF mirror since it is byte-identical to dev's gated ae.safetensors —
# black-forest-labs/FLUX.1-schnell is now gated and 401s without an HF token).

set -euo pipefail
cd "$(dirname "$0")"

MODELS_DIR="./models"
OUTPUT_DIR="./output"
PORT="${SD_PORT:-1234}"
[ -f .env ] && PORT="$(grep -E '^SD_PORT=' .env | cut -d= -f2 || echo 1234)"
PORT="${PORT:-1234}"

# name -> Hugging Face resolve URL. Edit here (and .env) to use different weights.
declare -A FILES=(
  ["flux1-dev-Q4_0.gguf"]="https://huggingface.co/city96/FLUX.1-dev-gguf/resolve/main/flux1-dev-Q4_0.gguf"
  ["t5-v1_1-xxl-encoder-Q4_K_M.gguf"]="https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf/resolve/main/t5-v1_1-xxl-encoder-Q4_K_M.gguf"
  ["clip_l.safetensors"]="https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors"
  ["ae.safetensors"]="https://huggingface.co/second-state/FLUX.1-schnell-GGUF/resolve/main/ae.safetensors"
)

log() { printf '\033[1;36m[image-gen]\033[0m %s\n' "$*"; }

require() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required but not installed" >&2; exit 1; }; }

download_models() {
  require curl
  mkdir -p "$MODELS_DIR" "$OUTPUT_DIR"
  for name in "${!FILES[@]}"; do
    local dest="$MODELS_DIR/$name"
    if [ -s "$dest" ]; then
      log "already present: $name"
      continue
    fi
    log "downloading $name ..."
    # -L follow redirects, -f fail on HTTP errors, -C - resume partial downloads.
    curl -fL -C - -o "$dest" "${FILES[$name]}" \
      || { echo "error: failed to download $name" >&2; rm -f "$dest"; exit 1; }
  done
  log "models ready in $MODELS_DIR"
}

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@";
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@";
  else echo "error: docker compose is not available" >&2; exit 1; fi
}

up()   { require docker; compose up -d; log "server on http://localhost:$PORT/v1/images/generations"; }
down() { compose down; }
logs() { compose logs -f sd-server; }

test_server() {
  require curl
  mkdir -p "$OUTPUT_DIR"
  local out="$OUTPUT_DIR/test-$(date +%s).png"
  log "requesting a test image from port $PORT ..."
  # Extract b64_json from the OpenAI-shaped response and decode to a PNG.
  local b64
  b64="$(curl -fsS "http://localhost:$PORT/v1/images/generations" \
    -H 'Content-Type: application/json' \
    -d '{"prompt":"a lovely cat, cinematic lighting","n":1,"size":"512x512"}' \
    | sed -n 's/.*"b64_json"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [ -n "$b64" ] || { echo "error: no image in response (is the model still loading?)" >&2; exit 1; }
  echo "$b64" | base64 -d > "$out"
  log "saved $out"
}

case "${1:-all}" in
  models) download_models ;;
  up)     up ;;
  down)   down ;;
  logs)   logs ;;
  test)   test_server ;;
  all)    download_models; up ;;
  *)      echo "usage: $0 {all|models|up|down|logs|test}" >&2; exit 1 ;;
esac
