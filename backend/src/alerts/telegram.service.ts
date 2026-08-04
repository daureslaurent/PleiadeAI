import { createLogger } from '../config/logger';
import { telegramClient } from '../telegram/TelegramClient';
import { telegramChatIds } from '../telegram/telegram-config';

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

  /** Chats that receive alerts — the runtime config (DB settings, env fallback). */
  targets(): string[] {
    return telegramChatIds();
  },

  async send(
    title: string,
    content: string,
    /**
     * Media the alert is *about* — a rendered clip, a generated image. A headless task that produced
     * one should deliver it, not just describe it and leave the operator to open the web UI.
     */
    attachments: { bytes: Buffer; filename: string; mime: string }[] = [],
  ): Promise<void> {
    if (!this.isConfigured()) {
      log.debug('telegram not configured; skipping alert');
      return;
    }
    const text = `*${title}*\n${content}`;
    await Promise.all(
      this.targets().map(async (chatId) => {
        await telegramClient.sendMessage(chatId, text);
        // Sequential per chat so files arrive under their own message in order; failures are logged
        // by the client and must not lose the text alert that already went out.
        for (const file of attachments) {
          await telegramClient.sendMedia(chatId, file);
        }
      }),
    );
  },
};
