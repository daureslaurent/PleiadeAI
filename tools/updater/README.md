# tools/updater — host self-update watcher

Lets **Settings → System & Updates → "Update app"** update the whole stack (git pull
+ `docker compose build` then `up -d`) even though the backend runs inside a container
that the update rebuilds and swaps.

## How it works

```
Browser ──POST /api/host/update──▶ backend ──writes──▶ <repo>/.update/trigger
                                                              │ (bind mount)
                                                              ▼
                                              systemd pleiade-update.path
                                                              │ file appeared
                                                              ▼
                                              pleiade-update.service
                                                  rm trigger → update_run.sh
```

The backend **never** runs docker or git for updates — it only drops a trigger file into
the bind-mounted `./.update` directory. A host-side systemd `.path` unit watches that file
and runs `update_run.sh` on the host, so the update survives `docker compose down`.

The frontend shows an "Updating…" overlay that tails the host log and reloads the page once
the rebuilt stack is back up.

## Update *checking* (the sidebar pin)

A second, read-only path tells the app **whether** an update exists, so the Settings page
can list the commits ahead and the sidebar can show a pin:

```
backend (hourly / "Check now") ──writes──▶ <repo>/.update/check   (trigger)
                                                   │ (bind mount)
                                                   ▼
                                   systemd pleiade-update-check.path
                                                   ▼
                                   pleiade-update-check.service
                                       rm check → check_run.sh
                                                   │
                              git fetch origin master + compare HEAD..origin/master
                                                   ▼
                                  writes <repo>/.update/status.json ──▶ backend reads it
```

`check_run.sh` never rebuilds anything; it only fetches and writes `status.json`
(current/remote sha, how many commits ahead, version strings, and each commit's
author/subject/body, base64-encoded so arbitrary commit text can't break the JSON). The
check interval is set in **Settings → System & Updates** (default 1 hour).

## Tracked branch

Updates track **`master`**. `update_run.sh` fast-forwards the deployed checkout to
`origin/master`; `check_run.sh` compares `HEAD..origin/master`.

## Install (on the host, once)

```bash
sudo tools/updater/install-updater.sh
```

Resolves the repo path automatically, installs both unit pairs (update + update-check) to
run as the repo's owner (must be in the `docker` group), creates `./.update`, and enables
the watchers. Then turn on **Settings → System & Updates → Enable app updates**.

Also install the version auto-bump hook once (bumps `frontend/src/version.json` per commit):

```bash
sh scripts/install-hooks.sh
```

## Uninstall

```bash
sudo tools/updater/uninstall-updater.sh
```

## Notes / troubleshooting

- The `update_enabled` setting (off by default) gates the API endpoint, so the button does
  nothing unless explicitly enabled.
- `docker-compose.yml` bind-mounts `./.update` into the backend. If that mount is missing the
  backend reports the bridge as "not ready" and the button is disabled with a hint.
- Update output is appended to `./.update/update.log` and also visible via
  `journalctl -u pleiade-update.service` (or `…-update-check.service`).
- Trigger a manual update for testing: `touch ./.update/trigger`.
- Trigger a manual check for testing: `touch ./.update/check` → inspect `./.update/status.json`.
