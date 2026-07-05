#!/usr/bin/env bash
#
# check_run.sh — read-only update check for the host watcher.
#
# The backend can't run git (it's in a container), so it drops a `.update/check`
# trigger; a systemd .path unit runs this script on the host. We fetch origin/master,
# compare it to the deployed checkout (HEAD), and write the result to
# .update/status.json — which is bind-mounted into the backend and read back to
# drive the "update available" pin and the commits-ahead list.
#
# Author/subject/body are base64-encoded so arbitrary commit text can never break the
# JSON; the backend decodes them. On any failure we still write a valid status.json
# carrying an "error" field, so the watcher never loops on a bad run.
set -uo pipefail

cd "$(dirname "$0")"

BRANCH="master"
STATUS=".update/status.json"
TMP=".update/status.json.$$.tmp"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p .update

write_error() {
  printf '{"checkedAt":"%s","currentSha":"","currentShortSha":"","remoteSha":"","remoteShortSha":"","branch":"%s","behindBy":0,"currentVersion":"","remoteVersion":"","commits":[],"error":"%s"}\n' \
    "$NOW" "$BRANCH" "$1" > "$TMP"
  mv -f "$TMP" "$STATUS"
}

# Read the app version string out of frontend/src/version.json at a given ref.
# Empty when the ref or file can't be read — the UI falls back gracefully.
ver_of() {
  git show "$1:frontend/src/version.json" 2>/dev/null \
    | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  write_error "not a git repository"
  exit 0
fi

if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  write_error "git fetch origin $BRANCH failed"
  exit 0
fi

CUR="$(git rev-parse HEAD 2>/dev/null)"
CURS="$(git rev-parse --short HEAD 2>/dev/null)"
REM="$(git rev-parse "origin/$BRANCH" 2>/dev/null)"
REMS="$(git rev-parse --short "origin/$BRANCH" 2>/dev/null)"
COUNT="$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null)"
[[ "$COUNT" =~ ^[0-9]+$ ]] || COUNT=0

# App version strings on each side, so the UI can show "v1.0.2 -> v1.0.5".
CURVER="$(ver_of HEAD)"
REMVER="$(ver_of "origin/$BRANCH")"

# Build the commits-ahead JSON array. Fields are separated by US (0x1f) and records
# by RS (0x1e); author + subject + body are base64-encoded (no -w wrapping) to avoid
# any JSON-escaping concerns. shas/dates are inherently JSON-safe.
commits_json=""
if [[ "$COUNT" -gt 0 ]]; then
  while IFS=$'\x1f' read -r -d $'\x1e' H SH DATE AUTH SUBJ BODY; do
    # git separates records with a newline; strip the one that leaks into the sha.
    H="${H#$'\n'}"
    [[ -z "$H" ]] && continue
    a="$(printf '%s' "$AUTH" | base64 | tr -d '\n')"
    s="$(printf '%s' "$SUBJ" | base64 | tr -d '\n')"
    b="$(printf '%s' "$BODY" | base64 | tr -d '\n')"
    item="{\"sha\":\"$H\",\"shortSha\":\"$SH\",\"date\":\"$DATE\",\"authorB64\":\"$a\",\"subjectB64\":\"$s\",\"bodyB64\":\"$b\"}"
    commits_json="${commits_json:+$commits_json,}$item"
  done < <(git log "HEAD..origin/$BRANCH" --pretty=format:'%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%b%x1e')
fi

printf '{"checkedAt":"%s","currentSha":"%s","currentShortSha":"%s","remoteSha":"%s","remoteShortSha":"%s","branch":"%s","behindBy":%s,"currentVersion":"%s","remoteVersion":"%s","commits":[%s]}\n' \
  "$NOW" "$CUR" "$CURS" "$REM" "$REMS" "$BRANCH" "$COUNT" "$CURVER" "$REMVER" "$commits_json" > "$TMP"
mv -f "$TMP" "$STATUS"

echo "==> Update check done: $COUNT commit(s) ahead ($CURS -> $REMS)"
