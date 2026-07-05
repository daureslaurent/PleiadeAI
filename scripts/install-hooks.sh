#!/bin/sh
# Point git at the tracked hooks directory so the version auto-bump runs on every commit.
# Run once after cloning: sh scripts/install-hooks.sh
set -e
root="$(git rev-parse --show-toplevel)"
git -C "$root" config core.hooksPath scripts/hooks
chmod +x "$root/scripts/hooks/pre-commit" "$root/scripts/bump-version.mjs"
echo "Git hooks installed (core.hooksPath = scripts/hooks). Version will auto-bump on commit."
