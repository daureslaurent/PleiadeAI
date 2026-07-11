#!/usr/bin/env bash
#
# run.sh — one-shot bootstrap for the GGUF image generation server.
#
#   ./run.sh              download FLUX.1-dev GGUF weights (if missing), then start the server
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

# Read a key out of .env, falling back to the environment and then to a default.
env_get() {
  local key="$1" def="${2:-}" val=""
  [ -f .env ] && val="$(sed -n "s/^${key}=//p" .env | tail -n1 | tr -d '\r')"
  [ -n "$val" ] || val="$(printenv "$key" || true)"
  printf '%s' "${val:-$def}"
}

PORT="$(env_get SD_PORT 1234)"
# The four FLUX files, named exactly as docker-compose/.env expect them. The diffusion quant is
# whatever SD_DIFFUSION_MODEL asks for: city96/FLUX.1-dev-gguf publishes every flux1-dev-<QUANT>.gguf
# under one repo, so the URL is derived from the file name and any quant works with no edit here.
DIFFUSION_MODEL="$(env_get SD_DIFFUSION_MODEL flux1-dev-Q4_K_S.gguf)"
T5XXL="$(env_get SD_T5XXL t5-v1_1-xxl-encoder-Q4_K_M.gguf)"
CLIP_L="$(env_get SD_CLIP_L clip_l.safetensors)"
VAE="$(env_get SD_VAE ae.safetensors)"

# name -> Hugging Face resolve URL.
declare -A FILES=(
  ["$DIFFUSION_MODEL"]="https://huggingface.co/city96/FLUX.1-dev-gguf/resolve/main/$DIFFUSION_MODEL"
  ["$T5XXL"]="https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf/resolve/main/$T5XXL"
  ["$CLIP_L"]="https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/$CLIP_L"
  ["$VAE"]="https://huggingface.co/cocktailpeanut/xulf-schnell/resolve/main/$VAE"
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
  # The OpenAI route only reads prompt/n/size/output_format; native knobs (steps, sampler, real CFG
  # vs distilled guidance) ride along in an <sd_cpp_extra_args> block inside the prompt, which the
  # server strips before generating. Same mechanism the backend uses — see inference/image-generate.ts.
  local args='{"sample_params":{"sample_method":"euler","sample_steps":24,"guidance":{"txt_cfg":1.0,"distilled_guidance":3.5}}}'
  local body
  body="$(printf '{"prompt":"a lovely cat holding a sign says \\"flux.cpp\\", cinematic lighting <sd_cpp_extra_args>%s</sd_cpp_extra_args>","n":1,"size":"1024x1024"}' "$args")"
  # Extract b64_json from the OpenAI-shaped response and decode to a PNG.
  local b64
  b64="$(curl -fsS "http://localhost:$PORT/v1/images/generations" \
    -H 'Content-Type: application/json' \
    -d "$body" \
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
