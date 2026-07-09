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
echo "==> Building new images (old stack still serving)..."
docker compose build

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
