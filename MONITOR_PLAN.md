# MONITOR_PLAN.md — fleet monitoring page

Plan for the **Monitor** view: a fleet dashboard reading `monitor-client/` (see its README for the
`GET /metrics.json` shape) on every configured server, with in-memory history and threshold alerts.

Decisions taken with the operator (2026-07-18):

| Question | Decision |
|---|---|
| Target ↔ inference endpoint | **New `monitor_targets` entity**, each with an *optional* link to an `endpoints` doc. A box may run no inference, or two endpoints. |
| History | **Backend in-memory ring buffer** (~2h). Survives a page reload, shared across tabs, lost on backend restart. No Mongo writes. |
| Layout | **Fleet grid + drill-down.** One compact glass card per server; click to expand to full detail. |
| Beyond display | **Thresholds + alerts** into the existing `alertEngine` (inbox + Telegram). |

---

## Backend

`backend/src/domain/monitor/`

- **`monitor-target.model.ts`** — `monitor_targets`: `name`, `base_url`, `api_key_enc`
  (AES-256-GCM, `select: false`, like `finetune_servers` — the monitor-client key never reaches the
  browser), `endpoint_id` (ref `Endpoint`, nullable), `enabled`.
- **`monitor-target.repository.ts`** — CRUD, `listEnabled()`, `findByIdWithKey()`.
- **`monitor.types.ts`** — `MonitorSnapshot`, mirroring `monitor-client/monitor.mjs` exactly. Every
  field optional/nullable: the client degrades per-section and the UI must too.
- **`monitor.service.ts`** — fetch one target's `/metrics.json` (timeout, `X-API-Key`), typed result.
- **`monitor.poller.ts`** — polls every enabled target on `monitor_poll_seconds`, keeps the last
  ~2h of **reduced** samples (a full snapshot per tick × N targets would be heavy; history only
  needs the meters that get graphed) plus the newest full snapshot per target.
- **`monitor.alerts.ts`** — evaluates thresholds against each poll, dispatches via `alertEngine`
  with per-(target, rule) cooldown and a recovery notice. Unreachable is itself a rule.

`transport/http/routes/monitor.routes.ts` → `/api/monitor`:

| Route | Purpose |
|---|---|
| `GET /targets`, `POST /targets`, `PATCH /targets/:id`, `DELETE /targets/:id` | CRUD for Settings → Monitor |
| `POST /targets/:id/test` | probe now, surface the error verbatim in the settings form |
| `GET /live` | newest snapshot for every enabled target — what the grid renders |
| `GET /targets/:id/history` | reduced ring buffer for the drill-down graphs |

Wiring: register the router in `index.ts` behind `requireAuth`, start the poller next to
`startFinetunePoller()`. Settings keys (`monitor_*`: poll interval, alerts on/off, thresholds) go in
the settings doc with a migration, per repo convention.

## Frontend

- `views/MonitorView.tsx` — the page: fleet grid, drill-down, offline/empty states.
- `components/monitor/` — `ServerCard`, `ServerDetail`, `Meter`, `Sparkline`, `GpuPanel`,
  `SensorGrid`. Meters/tone helpers follow `components/finetune/ServerCard.tsx`, which already
  encodes the DIRECT_ART semantics (emerald headroom → amber tight → red saturated).
- `lib/api.ts` — `monitorApi` + types.
- Sidebar: new **Monitor** item under *Infrastructure*; route in `App.tsx`.
- Settings: new `monitor` category + `MonitorPanel` + `MonitorTargetsManager` (add target, with a
  picker that prefills the host from an inference endpoint's `base_url`).

Style is DIRECT_ART throughout: glass over the starfield, white-alpha hairlines, mono for machine
output, motion only for liveness (a polling card shimmers; a stale one does not).

## Status

- [x] Backend domain + poller + alerts + routes
- [x] Settings: schema, migration, panel, target manager
- [x] Frontend: API client, Monitor view, cards, drill-down, sparklines
- [x] Sidebar + route
- [x] Typecheck both apps
- [x] Configurable history depth (`monitor_history_samples`, clamped 60…100,000) + a live RAM
      readout in Settings → Monitor (`GET /monitor/stats`)

### Note

The settings `PUT` whitelists keys (`settings.routes.ts`). Any new `monitor_*` setting must be added
there too, or it silently never persists — that bug shipped in the first commit and cost the whole
panel; it is fixed and worth remembering for the next key added here.
