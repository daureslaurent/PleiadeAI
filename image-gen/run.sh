#!/usr/bin/env bash
#
# run.sh — one-shot bootstrap for the GGUF image generation server.
#
#   ./run.sh              download FLUX.2 GGUF weights (if missing), then start the server
#   ./run.sh models       download the model files only
#   ./run.sh up           start the server only (assumes models present)
#   ./run.sh down         stop the server
#   ./run.sh logs         follow server logs
#   ./run.sh test         POST a sample prompt to the running server and save the PNG
#
# Weights are pulled from Hugging Face into ./models (~15 GB for the default). See .env.example to
# swap models. Defaults target FLUX.2-klein-9B (upstream docs/flux2.md): diffusion GGUF from leejet,
# the Qwen3-8B LLM text encoder from unsloth, and the VAE from the ungated Comfy-Org mirror. Every
# source is ungated, so no Hugging Face token is needed.

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

# The three FLUX.2 files, named exactly as docker-compose/.env expect them.
DIFFUSION_MODEL="$(env_get SD_DIFFUSION_MODEL flux-2-klein-9b-Q8_0.gguf)"
LLM="$(env_get SD_LLM Qwen3-8B-Q4_K_M.gguf)"
VAE="$(env_get SD_VAE flux2-vae.safetensors)"

# Each URL is derived from the file NAME, so swapping quant/variant in .env needs no edit here.
# Diffusion: leejet publishes one GGUF repo per klein variant (FLUX.2-klein-{4B,9B,base-4B,base-9B}),
# each holding every quant of that variant — so the repo is recovered from the file name itself.
# FLUX.2-dev (city96/FLUX.2-dev-gguf) is deliberately not wired up: it needs ~19GB of weights plus a
# 24B Mistral encoder, which won't run on this box.
case "$DIFFUSION_MODEL" in
  flux-2-klein-base-4b-*) DIFFUSION_REPO="leejet/FLUX.2-klein-base-4B-GGUF" ;;
  flux-2-klein-base-9b-*) DIFFUSION_REPO="leejet/FLUX.2-klein-base-9B-GGUF" ;;
  flux-2-klein-4b-*)      DIFFUSION_REPO="leejet/FLUX.2-klein-4B-GGUF" ;;
  flux-2-klein-9b-*)      DIFFUSION_REPO="leejet/FLUX.2-klein-9B-GGUF" ;;
  *) echo "error: don't know which HF repo serves '$DIFFUSION_MODEL' — add a case here" >&2; exit 1 ;;
esac
# LLM text encoder: Qwen3 for the klein family (unsloth's GGUFs). 9B pairs with Qwen3-8B, 4B with 4B.
case "$LLM" in
  Qwen3-8B-*) LLM_REPO="unsloth/Qwen3-8B-GGUF" ;;
  Qwen3-4B-*) LLM_REPO="unsloth/Qwen3-4B-GGUF" ;;
  *) echo "error: don't know which HF repo serves '$LLM' — add a case here" >&2; exit 1 ;;
esac

# name -> Hugging Face resolve URL. The VAE comes from the ungated Comfy-Org mirror; the
# black-forest-labs FLUX.2-dev repo that upstream links is gated and 401s without an HF token.
declare -A FILES=(
  ["$DIFFUSION_MODEL"]="https://huggingface.co/$DIFFUSION_REPO/resolve/main/$DIFFUSION_MODEL"
  ["$LLM"]="https://huggingface.co/$LLM_REPO/resolve/main/$LLM"
  ["$VAE"]="https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/$VAE"
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
  local args='{"seed":-1,"sample_params":{"sample_method":"euler","sample_steps":4,"guidance":{"txt_cfg":1.0}}}'
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
