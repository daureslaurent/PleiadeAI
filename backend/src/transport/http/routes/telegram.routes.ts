import { Router } from 'express';
import { env } from '../../../config/env';
import { telegramClient } from '../../../telegram/TelegramClient';
import { telegramBot } from '../../../telegram/TelegramBot';
import { telegramChatIds } from '../../../telegram/telegram-config';
import { telegramService } from '../../../alerts/telegram.service';

/**
 * Telegram bot status + test-send for the Autonomy page. Configuration itself lives in the
 * settings singleton (`telegram_bot_token` / `telegram_chat_ids`, PUT /api/settings) — these
 * routes only report the effective state and exercise the alert leg.
 */
export const telegramRouter = Router();

/** Effective Telegram state: token presence, live bot identity (getMe), targets, polling. */
telegramRouter.get('/status', async (_req, res) => {
  const configured = telegramClient.isConfigured();
  // getMe doubles as a token validity probe; null with a token set ⇒ invalid token / outage.
  const bot = configured ? await telegramClient.getMe() : null;
  res.json({
    configured,
    bot: bot ? { id: bot.id, username: bot.username ?? null } : null,
    targets: telegramChatIds(),
    polling: env.TELEGRAM_POLLING,
    running: telegramBot.isRunning(),
  });
});

/** Send a test alert to every configured target chat. */
telegramRouter.post('/test', async (req, res) => {
  if (!telegramService.isConfigured()) {
    res.status(400).json({ error: 'telegram is not configured (set a bot token and at least one chat id)' });
    return;
  }
  const message =
    typeof req.body?.message === 'string' && req.body.message.trim()
      ? req.body.message.trim()
      : 'Test notification from the PleiadesAI Autonomy page.';
  await telegramService.send('PleiadesAI test', message);
  res.json({ ok: true, targets: telegramService.targets() });
});
