import { createLogger } from '../config/logger';
import { telegramToken } from './telegram-config';

const log = createLogger('telegram-client');

/** Telegram caps a single text message at 4096 chars; we split on that boundary. */
const MAX_MESSAGE_LEN = 4096;

/** A single button in an inline keyboard row. */
export interface InlineButton {
  text: string;
  /** Opaque payload delivered back as a `callback_query` when tapped. */
  callback_data: string;
}

/** Bot command as advertised in the client's `/` menu via `setMyCommands`. */
export interface BotCommand {
  command: string;
  description: string;
}

/** Minimal shape of the pieces of a Telegram `Update` we act on. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; username?: string; first_name?: string };
    message?: { message_id: number; chat: { id: number } };
  };
}

/**
 * Thin typed wrapper over the Telegram Bot API (raw `fetch`, no SDK dependency). Shared by the
 * outbound alert leg and the interactive command bot so both speak to Telegram through one place.
 * Every call degrades to a no-op / null when no bot token is configured.
 */
class TelegramClient {
  isConfigured(): boolean {
    return Boolean(telegramToken());
  }

  private async call<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    { timeoutMs }: { timeoutMs?: number } = {},
  ): Promise<T | null> {
    if (!this.isConfigured()) return null;
    const url = `https://api.telegram.org/bot${telegramToken()}/${method}`;
    const controller = timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
      if (!json.ok) {
        log.warn({ method, status: res.status, description: json.description }, 'telegram api error');
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      // AbortError on the long-poll is expected (timeout / shutdown); log the rest.
      if (!(err instanceof Error && err.name === 'AbortError')) {
        log.error({ err, method }, 'telegram request failed');
      }
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Bot identity — used at boot to confirm the token and log the handle. */
  async getMe(): Promise<{ id: number; username?: string } | null> {
    return this.call('getMe', {});
  }

  /**
   * Send text, splitting into 4096-char chunks. Markdown parse mode is best-effort: on a parse
   * failure Telegram rejects the whole message, so we retry the chunk as plain text.
   */
  async sendMessage(
    chatId: number | string,
    text: string,
    opts: { keyboard?: InlineButton[][]; markdown?: boolean } = {},
  ): Promise<void> {
    const chunks = splitMessage(text || '(empty)');
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = { chat_id: chatId, text: chunks[i] };
      if (opts.markdown !== false) body.parse_mode = 'Markdown';
      // Only the last chunk carries the keyboard so buttons sit under the full message.
      if (opts.keyboard && i === chunks.length - 1) {
        body.reply_markup = { inline_keyboard: opts.keyboard };
      }
      const ok = await this.call('sendMessage', body);
      if (ok === null && body.parse_mode) {
        delete body.parse_mode;
        await this.call('sendMessage', body);
      }
    }
  }

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    opts: { keyboard?: InlineButton[][] } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: splitMessage(text)[0],
      parse_mode: 'Markdown',
    };
    if (opts.keyboard) body.reply_markup = { inline_keyboard: opts.keyboard };
    await this.call('editMessageText', body);
  }

  /** Acknowledge a button tap (removes the client's loading spinner). */
  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  /** Show a transient "typing…" indicator while an agent turn runs. */
  async sendChatAction(chatId: number | string, action = 'typing'): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action });
  }

  /** Register the slash-command menu shown in the Telegram UI. */
  async setMyCommands(commands: BotCommand[]): Promise<void> {
    await this.call('setMyCommands', { commands });
  }

  /**
   * Long-poll for updates. `timeoutSec` is Telegram's server-side hold; we give the HTTP request a
   * few extra seconds before aborting so a healthy poll never trips the client timeout.
   */
  async getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    const result = await this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
      { timeoutMs: (timeoutSec + 10) * 1000 },
    );
    return result ?? [];
  }
}

/** Split on newlines where possible so chunks don't break mid-line. */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LEN) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_MESSAGE_LEN) {
    let cut = remaining.lastIndexOf('\n', MAX_MESSAGE_LEN);
    if (cut <= 0) cut = MAX_MESSAGE_LEN;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export const telegramClient = new TelegramClient();
