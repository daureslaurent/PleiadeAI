#!/usr/bin/env bash
set -euo pipefail

# Update PleiadeAI: pull latest from build branch, then rebuild the stack.

cd "$(dirname "$0")"

echo "==> Fetching latest commit from build branch..."
git fetch origin build
git checkout build
git reset --hard origin/build

echo "==> Stopping stack..."
docker compose down

echo "==> Rebuilding and starting stack..."
docker compose up --build -d

echo "==> Done."
