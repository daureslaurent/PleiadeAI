# Telegram Bot Refactor Plan

> Status: ✅ implemented — `backend/npm run typecheck` passes.


## Goal
Turn the outbound-only Telegram alert leg into a full interactive bot: a command menu,
inline-keyboard navigation, per-chat agent selection + conversation, and the existing
completion alerts — all driven from the single-operator backend.

## Current state
- `alerts/telegram.service.ts` — one-way `send(title, content)` via Bot API `sendMessage`.
- `alerts/AlertEngine.ts` — fans a completed headless task to Mongo notification + Telegram.
- Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (both optional).
- No inbound handling, no menu, no way to chat with an agent from Telegram.

## Design
New `backend/src/telegram/` module (mirrors `alerts/`, `autonomy/` layout):

1. **`TelegramClient.ts`** — thin typed wrapper over the Bot API using `fetch` (no new dep):
   `sendMessage` (Markdown, 4096-char chunking, inline keyboards), `editMessageText`,
   `answerCallbackQuery`, `sendChatAction`, `setMyCommands`, `getUpdates` (long poll),
   `getMe`. Central `isConfigured()`.

2. **`session.ts`** — in-memory per-chat state: `{ agentName, history: ChatMessage[],
   abort?: AbortController, running: boolean }`. Single-operator → memory is fine (resets on
   restart). Helpers: get/reset/setAgent.

3. **`TelegramBot.ts`** — long-polling loop + update router:
   - `start()`: register commands (`setMyCommands`), then loop `getUpdates` with offset,
     dispatch each update, isolate handler errors.
   - Authorization allowlist (`TELEGRAM_ALLOWED_CHAT_IDS` CSV, falling back to
     `TELEGRAM_CHAT_ID`); unknown chats get a denial + their id so the operator can allow them.
   - Commands: `/start`, `/help`, `/agents`, `/agent <name>`, `/new`, `/status`, `/cancel`.
   - Callback queries: agent-picker buttons (`agent:<name>`), `new`, `agents`, `help`.
   - Plain text → run the selected agent via `agentRunner.run` (headless, like cron), with
     `sendChatAction('typing')`, per-chat history, `/cancel` abort, chunked reply.
   - Default agent = first non-subagent when none selected.

4. **`alerts/telegram.service.ts`** — refactor to delegate to `TelegramClient` so alerts and the
   bot share one transport; broadcast alerts to every allowed chat. Keeps the same `send`/
   `isConfigured` surface so `AlertEngine` is untouched.

5. **Env (`config/env.ts`, `.env.example`)** — add optional `TELEGRAM_ALLOWED_CHAT_IDS` (CSV) and
   `TELEGRAM_POLLING` (bool, default true) to gate the inbound loop.

6. **Wiring (`index.ts`)** — after Agenda setup, `telegramBot.start()` when configured + polling
   enabled; `telegramBot.stop()` on shutdown. Boot failures are logged, never fatal.

## Notes / constraints
- All config via the validated `env` object; structured Pino logging only.
- No test suite → verify with `npm run typecheck` in `backend/`.
- Graceful degradation: no token ⇒ bot is a no-op, alerts still hit Mongo.
- Reuses `agentRunner.run` (returns final answer string) exactly like `agenda.setup.ts`.
