#!/usr/bin/env bash
#
# update_run.sh — rapid update & relaunch, run on the HOST by the systemd watcher.
# Fetches the latest master, then rebuilds and swaps the stack with minimal downtime.
#
# The backend only drops a `.update/trigger` file; this script runs on the host (via
# systemd) so it survives the very containers it rebuilds. Do not run this inside the
# backend container.
set -euo pipefail

cd "$(dirname "$0")"

BRANCH="master"

echo "==> Updating $BRANCH from git..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

# Build the new images while the old containers keep running — no downtime during the
# (slow) build step.
#
# One service at a time, deliberately. `docker compose build` with no arguments hands every
# service to BuildKit at once, which runs the backend's `tsc` (~880 MB RSS) and the frontend's
# Rollup (~2.3 GB at the default 2048 cap) *concurrently* — and it is the sum that decides whether
# a small VPS survives. Worse, the old stack is still serving during this step by design, so mongo,
# qdrant, searxng and the embeddings llama.cpp are all resident too. The two build-weight specs
# measured that overlap; on a swapless box it lands as `exit code 137` on whichever stage the OOM
# killer reaches first. Building in sequence costs wall-clock time and nothing else.
#
# Set BUILD_PARALLEL=1 on a builder with RAM to spare to get the concurrent build back.
echo "==> Building new images (old stack still serving)..."
if [ "${BUILD_PARALLEL:-0}" = "1" ]; then
  docker compose build
else
  docker compose build backend
  docker compose build frontend
  # Catches any service added later that also builds from source; a cache hit for the two above.
  docker compose build
fi

# Recreate only the services whose image/config changed. Named-volume data (Mongo,
# Qdrant) is untouched, so downtime is just the few seconds it takes to swap containers.
echo "==> Swapping in new containers..."
docker compose up -d

# Drop now-dangling old image layers freed by the rebuild. Dangling-only (no -a), so
# tagged per-agent isolation images (pleiades_agent*) are left alone.
echo "==> Pruning dangling images..."
docker image prune -f

echo "==> Done. Container status:"
docker compose ps
