#!/usr/bin/env bash
#
# uninstall-updater.sh — remove the host-side self-update watcher units.
# Leaves the repo's ./.update directory (and its logs) in place.
#
# Usage:  sudo tools/updater/uninstall-updater.sh
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This removes system units and must run as root. Re-run with: sudo $0" >&2
  exit 1
fi

for unit in pleiades-update.path pleiades-update.service \
            pleiades-update-check.path pleiades-update-check.service; do
  systemctl disable --now "$unit" 2>/dev/null || true
  rm -f "/etc/systemd/system/$unit"
  echo "==> Removed $unit"
done

systemctl daemon-reload
echo "Done. The host update watchers are uninstalled."
