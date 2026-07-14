import { env } from '../config/env';

/**
 * Mutable runtime Telegram configuration. The DB settings singleton is the source of truth
 * (Settings → editable from the Autonomy page); env vars seed the initial state and act as the
 * fallback for fields left empty in the DB (see settings.service). `applyTelegramConfig` is called
 * at boot and again on every settings save, so `TelegramClient`, the alert fan-out and the
 * interactive bot all pick up token/chat changes without a redeploy.
 */
const state = {
  token: env.TELEGRAM_BOT_TOKEN ?? '',
  chatIds: env.TELEGRAM_ALLOWED_CHAT_IDS ?? env.TELEGRAM_CHAT_ID ?? '',
};

export function applyTelegramConfig(cfg: {
  telegram_bot_token: string;
  telegram_chat_ids: string;
}): void {
  state.token = cfg.telegram_bot_token;
  state.chatIds = cfg.telegram_chat_ids;
}

/** The active bot token ('' → Telegram fully disabled). */
export function telegramToken(): string {
  return state.token;
}

/** Chat ids that receive alerts and are allowed to talk to the bot (comma list, trimmed). */
export function telegramChatIds(): string[] {
  return state.chatIds
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
