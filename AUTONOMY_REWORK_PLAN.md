# AUTONOMY_REWORK_PLAN.md — Autonomy page rework

Full rework of the Autonomy view into a single command board (spec §5), aligned with
`DIRECT_ART.md`. Decisions taken with the operator (2026-07-14):

- **Layout**: master-detail + rail — left: schedules (CRUD); center: selected schedule's run
  history; right rail: notifications inbox (always visible) + Telegram card.
- **Telegram**: DB-backed config (settings singleton, env fallback — same pattern as the Google
  OAuth client), editable in the UI, with bot-identity check (`getMe`) and test-send.
- **Extras**: agent picker + identity colors, cron helper (presets + next-occurrences preview),
  inbox upgrades (mark-all-read, unread filter, sidebar badge, relative times, agent attribution),
  auto-refresh / liveness (running jobs glow + shimmer).
- **Inbox CRUD**: add `DELETE /api/inbox/:id` + `POST /api/inbox/clear-read`.

## Backend

1. **Telegram runtime config** — `telegram/telegram-config.ts`: mutable module state
   `{ token, chatIds }` seeded from env, overridden by settings. `settings.model` +
   `settings.service` gain `telegram_bot_token` / `telegram_chat_ids` (`''` → env fallback;
   `redact.ts` already scrubs `*_token` for API keys). `TelegramClient`, `telegram.service`
   (alert targets) and `TelegramBot` (allowlist) all read through it. `settings.routes` applies
   the new config and restarts the bot when telegram fields change; `index.ts` applies it at boot
   before `telegramBot.start()`. `TelegramBot` gains `restart()` (stop → await poll loop → start)
   and `isRunning()`.
2. **Telegram status/test routes** — new `/api/telegram`: `GET /status` (configured, bot identity
   via `getMe`, targets, polling flag, bot running) and `POST /test` (send a test alert through
   `telegramService.send`).
3. **Inbox** — repository `remove(id)` + `clearRead()`; routes `DELETE /:id`,
   `POST /clear-read`.
4. **Cron preview** — `previewCron(expr, count)` in `autonomy/cron.ts` (cron-parser, SCHEDULE_TZ);
   route `GET /api/autonomy/cron/preview?expr=…` → `{ valid, error, next[3], timezone }`.
5. **Job liveness** — `GET /api/autonomy/jobs` adds `running: Boolean(lockedAt)`.

## Frontend

1. **`views/autonomy/`** — new folder replacing `AutonomyInbox.tsx`:
   - `AutonomyView.tsx` — three-pane board, data loading, polling (jobs 15s / 5s while a run is
     live; inbox 30s), agent identity registration.
   - `ScheduleForm.tsx` — glass-card modal for create/edit: agent picker (real agents, identity
     dots), prompt, recurring/one-off, cron input with preset chips + live next-3-occurrences
     preview, alert toggle.
   - `RunHistoryPanel.tsx` — per-schedule run cards: status pill, finish time, duration, prompt,
     markdown output; run-now refresh loop.
   - `InboxPanel.tsx` — unread badge, unread-only filter, mark-read / mark-all / delete /
     clear-read, agent attribution + relative times.
   - `TelegramPanel.tsx` — status card (`getMe` identity, targets, polling) + inline config form
     (token, chat ids) saved via settings, and test-send.
2. **`lib/api.ts`** — `running` on `AutonomyJob`, `cronPreview`, inbox additions
   (`unreadCount`, `readAll`, `remove`, `clearRead`), `telegramApi`, telegram settings fields.
3. **`Sidebar.tsx`** — unread-count badge on the Autonomy nav item (60s poll).
4. **`App.tsx`** — route to the new view; delete `AutonomyInbox.tsx`.

DA rules applied: glass cards over the starfield, white-alpha hairlines/hovers, identity colors +
`--glow` for running schedules, shimmer only on live labels, mono for cron/machine text,
`rounded-xl` in-flow cards / `rounded-2xl` floating modal, red reserved for kill/delete.

## Verification

`npm run typecheck` (both apps) + boot the stack and exercise: schedule CRUD, run-now, results,
inbox actions, telegram config + test-send.
