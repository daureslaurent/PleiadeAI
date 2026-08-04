import { createLogger } from '../config/logger';
import { telegramToken } from './telegram-config';

const log = createLogger('telegram-client');

/** Telegram caps a single text message at 4096 chars; we split on that boundary. */
const MAX_MESSAGE_LEN = 4096;
/** Captions on media are capped far lower than message text. */
const MAX_CAPTION_LEN = 1024;
/** Uploads and downloads move real megabytes over a consumer link — far longer than an API call. */
const FILE_TIMEOUT_MS = 120_000;
/** Bots may not download anything larger than this (Telegram's limit, enforced at `getFile`). */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Photos are capped tighter than other media; a bigger image has to go as a document. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Which Bot API method renders this content best, and the form field it wants.
 *
 * Sending everything as a document would always *work* — and would make every generated image an
 * attachment the operator has to tap to open, every clip a file rather than a player. The type is
 * what makes the result usable in the client.
 */
function mediaMethodFor(mime: string): { method: string; field: string } {
  if (mime.startsWith('image/')) {
    // Telegram re-encodes `sendPhoto` and rejects GIF/SVG there; animations and vectors keep their
    // fidelity only as a document or animation.
    if (mime === 'image/gif') return { method: 'sendAnimation', field: 'animation' };
    if (mime === 'image/svg+xml') return { method: 'sendDocument', field: 'document' };
    return { method: 'sendPhoto', field: 'photo' };
  }
  if (mime.startsWith('video/')) return { method: 'sendVideo', field: 'video' };
  if (mime.startsWith('audio/')) return { method: 'sendAudio', field: 'audio' };
  return { method: 'sendDocument', field: 'document' };
}

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

/** A file Telegram holds, in every media field's payload. */
export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
  /** Photos only — Telegram sends an array of sizes, largest last. */
  width?: number;
  height?: number;
  duration?: number;
}

/** Minimal shape of the pieces of a Telegram `Update` we act on. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    /** Text accompanying a media message — the user's actual instruction. */
    caption?: string;
    /** Compressed photo, in ascending size order; the last entry is the largest. */
    photo?: TelegramFile[];
    /** A recorded voice note (opus). `audio` is a music/file send instead. */
    voice?: TelegramFile;
    audio?: TelegramFile;
    video?: TelegramFile;
    /** Round "telescope" video message. */
    video_note?: TelegramFile;
    animation?: TelegramFile;
    /** Any uncompressed file — how an image sent "as file" arrives. */
    document?: TelegramFile;
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

  /**
   * Download a file the user sent. Two steps by Telegram's design: `getFile` resolves a `file_id`
   * into a temporary path, which is then fetched from the *file* host rather than the API host.
   *
   * Bots may only download files up to 20MB; beyond that Telegram refuses at the `getFile` step, so
   * a null here usually means "too big", not "broken".
   */
  async downloadFile(fileId: string): Promise<{ bytes: Buffer; path: string } | null> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file?.file_path) return null;
    try {
      const res = await fetch(
        `https://api.telegram.org/file/bot${telegramToken()}/${file.file_path}`,
        { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) },
      );
      if (!res.ok) {
        log.warn({ fileId, status: res.status }, 'telegram file download failed');
        return null;
      }
      return { bytes: Buffer.from(await res.arrayBuffer()), path: file.file_path };
    } catch (err) {
      log.error({ err, fileId }, 'telegram file download failed');
      return null;
    }
  }

  /**
   * Upload bytes as a photo / audio / video / document, picked from the mime type.
   *
   * Media goes as `multipart/form-data`, not the JSON every other call uses — hence the separate
   * path here rather than a branch inside `call`. Telegram renders each type differently (a photo
   * inline, audio with a player, video with a thumbnail), so choosing the right method is what makes
   * the result usable in the client rather than an attachment to download.
   */
  async sendMedia(
    chatId: number | string,
    file: { bytes: Buffer; filename: string; mime: string },
    opts: { caption?: string } = {},
  ): Promise<boolean> {
    if (!this.isConfigured()) return false;

    // An oversized photo is rejected outright by `sendPhoto`; as a document it still arrives.
    const oversizedPhoto = file.mime.startsWith('image/') && file.bytes.length > MAX_PHOTO_BYTES;
    const { method, field } = oversizedPhoto
      ? { method: 'sendDocument', field: 'document' }
      : mediaMethodFor(file.mime);

    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (opts.caption) form.append('caption', opts.caption.slice(0, MAX_CAPTION_LEN));
    form.append(field, new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.filename);

    try {
      const res = await fetch(`https://api.telegram.org/bot${telegramToken()}/${method}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) {
        log.warn({ method, description: json.description, mime: file.mime }, 'telegram media send failed');
        return false;
      }
      return true;
    } catch (err) {
      log.error({ err, method }, 'telegram media send failed');
      return false;
    }
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
