import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { telegramClient } from '../telegram/TelegramClient';

const log = createLogger('telegram');

/**
 * Outbound alert leg of the dual-alert pipeline (spec §5). Delegates transport to the shared
 * `TelegramClient` so alerts and the interactive bot speak to Telegram through one place. If no
 * bot token / target chat is configured, sending is a no-op — the persistent Mongo notification
 * still fires, so alerts are never fully lost.
 */
export const telegramService = {
  isConfigured(): boolean {
    return telegramClient.isConfigured() && this.targets().length > 0;
  },

  /** Chats that receive alerts: the allowlist if set, else the single TELEGRAM_CHAT_ID. */
  targets(): string[] {
    const raw = env.TELEGRAM_ALLOWED_CHAT_IDS ?? env.TELEGRAM_CHAT_ID ?? '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  },

  async send(title: string, content: string): Promise<void> {
    if (!this.isConfigured()) {
      log.debug('telegram not configured; skipping alert');
      return;
    }
    const text = `*${title}*\n${content}`;
    await Promise.all(
      this.targets().map((chatId) => telegramClient.sendMessage(chatId, text)),
    );
  },
};
