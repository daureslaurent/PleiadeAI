#!/usr/bin/env bash
#
# run_finetune_server.sh — bring up the standalone fine-tune service on the GPU host.
#
# The fine-tune service is a compose *sibling* that lives in its own directory
# (finetune/) with its own docker-compose.yml, .env, and dual-NVIDIA GPU reservation.
# It is NOT part of the root docker-compose.yml, so it gets its own launcher.
#
# This script runs on the host (the box with the GPUs), does a few pre-flight checks
# so failures are legible instead of a cryptic compose error, ensures the host-side
# workspace dirs and .env exist, then builds + starts the service detached.
#
# Usage:
#   ./run_finetune_server.sh            # build (if needed) + start detached, then tail logs
#   ./run_finetune_server.sh --rebuild  # force a clean --build of the image
#   ./run_finetune_server.sh --logs     # just follow logs of the running service
#   ./run_finetune_server.sh --down     # stop and remove the service
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/finetune"

SERVICE="finetune"
ACTION="up"

for arg in "$@"; do
  case "$arg" in
    --rebuild) ACTION="rebuild" ;;
    --logs)    ACTION="logs" ;;
    --down)    ACTION="down" ;;
    -h|--help)
      sed -n '2,19p' "$SELF" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

# --- Pre-flight ---------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed or not on PATH." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' (v2) is required." >&2
  exit 1
fi

# --down / --logs don't need the GPU/.env checks — handle them and exit early.
if [[ "$ACTION" == "down" ]]; then
  echo "==> Stopping fine-tune service..."
  docker compose down
  exit 0
fi

if [[ "$ACTION" == "logs" ]]; then
  exec docker compose logs -f "$SERVICE"
fi

# The compose file reserves NVIDIA GPUs; without the toolkit the container won't
# start. Warn loudly rather than fail — a CPU-only smoke test may still be wanted.
if command -v nvidia-smi >/dev/null 2>&1; then
  echo "==> Detected GPUs:"
  nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader | sed 's/^/    /'
else
  echo "WARNING: nvidia-smi not found. Training needs the NVIDIA container toolkit;" >&2
  echo "         the service will start but any /train run will fail without GPUs." >&2
fi

# Config is fail-fast at boot (Zod). Seed .env from the example on first run so the
# operator gets a clear "fill this in" instead of a boot crash.
if [[ ! -f .env ]]; then
  echo "==> No .env found — creating one from .env.example."
  cp .env.example .env
  echo "    Edit finetune/.env and set FINETUNE_API_KEY (>= 8 chars) before training." >&2
fi

# Host-side bind-mount targets (compose maps ./workspace/* into the container).
# Create them up front so docker doesn't make them root-owned on first mount.
mkdir -p workspace/data workspace/models workspace/runs

# --- Launch -------------------------------------------------------------------

if [[ "$ACTION" == "rebuild" ]]; then
  echo "==> Rebuilding image (no cache reuse for the app layer)..."
  docker compose build --pull
  docker compose up -d --force-recreate
else
  # --build so a changed Dockerfile/src is picked up; no-op when already current.
  echo "==> Building (if needed) and starting fine-tune service..."
  docker compose up -d --build
fi

echo "==> Status:"
docker compose ps

PORT="$(grep -E '^FINETUNE_PORT=' .env 2>/dev/null | cut -d= -f2)"
PORT="${PORT:-8088}"
echo "==> Health:  curl -sf http://localhost:${PORT}/health"
echo "==> Following logs (Ctrl-C to detach; the service keeps running)..."
exec docker compose logs -f "$SERVICE"
