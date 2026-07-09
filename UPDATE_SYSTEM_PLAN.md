# Update System Plan (ported from cryptoBot)

Self-update + update-check for PleiadesAI, adapted from cryptoBot's design.

## Decisions
- **Trigger mechanism:** systemd host watcher + bind-mounted `./.update` trigger files
  (backend never runs git/docker for updates; the update survives `docker compose down`).
  Note: PleiadesAI's backend *does* mount `/var/run/docker.sock` for agent isolation, but we
  still use the host watcher because a container can't reliably rebuild+swap itself.
- **Tracked branch:** `master`.
- **Scope:** update-check (pin + commits list) · update button + live log overlay ·
  `version.json` auto-bump + version badge. **No reboot button.**
- **UI:** a "System & Updates" section inside the existing `SettingsView`, plus a small
  sidebar version badge / update pin.

## Trust boundary
Everything gated by a new `update_enabled` setting (default **off**) + the `.update` bind
mount being present & writable (readiness check). Same master switch as cryptoBot.

## Host scripts (repo root)
- `check_run.sh` — `git fetch origin master`, compare `HEAD..origin/master`, write
  `.update/status.json` (behindBy, shas, version strings, base64 commit fields).
- `update_run.sh` — fetch master, `docker compose build` (old stack keeps serving),
  `docker compose up -d`, `docker image prune -f` (dangling only — leaves tagged
  `pleiades_agent*` isolation images alone).

## systemd units (tools/updater/install-updater.sh)
- `pleiades-update.path`/`.service` → `update_run.sh`
- `pleiades-update-check.path`/`.service` → `check_run.sh`
- Both run as the repo owner; `ExecStartPre=rm <trigger>` re-arms the `.path` unit.
- Logs appended to `.update/update.log`.

## Backend
- `src/host/update.ts` — drop `check`/`trigger` files, read `status.json`, tail
  `update.log`, readiness. Trigger dir from `env.UPDATE_TRIGGER_DIR` (default `/app/.update`).
- `src/host/updateChecker.ts` — periodic check refreshing `status.json` (interval from
  `update_check_interval_hours`, default 1). Frontend polls for the pin.
- `src/host/index.ts` — barrel.
- `src/transport/http/routes/host.routes.ts` — `GET /host/update`, `POST /host/update/check`,
  `POST /host/update`, `GET /host/update/log`. Mounted behind `requireAuth`.
- Settings: add `update_enabled` (bool, default false) + `update_check_interval_hours`
  (number, default 1) to model / service / routes whitelist.
- `env.ts`: add `UPDATE_TRIGGER_DIR` (default `/app/.update`).
- `index.ts`: register router + start `scheduleUpdateCheck`.

## Frontend
- `src/version.json` + `src/version.ts` (typed accessors).
- `lib/api.ts`: `hostApi` (getUpdate/checkUpdate/runUpdate/updateLog) + types; add the two
  new settings fields to `InferenceSettings`.
- `SettingsView`: "System & Updates" section — version badge, enable toggle, interval,
  "Check now", commits-ahead list, "Update app" button + tailed log overlay that reloads
  when the stack is back.
- `Sidebar`: version badge + "update available" pin (polls `hostApi.getUpdate`).

## Infra
- `docker-compose.yml`: bind-mount `./.update:/app/.update` on backend + `UPDATE_TRIGGER_DIR` env.
- `.gitignore`: ignore `.update/` runtime files.
- `.env.example`: document `UPDATE_TRIGGER_DIR`.

## Version auto-bump (scripts/)
- `bump-version.mjs` (pre-commit) bumps `frontend/src/version.json` patch/build/date.
- `hooks/pre-commit` + `install-hooks.sh` (sets `core.hooksPath`).

## Manual install (host, once)
```
sudo tools/updater/install-updater.sh      # installs systemd watchers, creates ./.update
sh scripts/install-hooks.sh                # version auto-bump on commit
```
Then enable **Settings → System & Updates → Enable app updates**.
