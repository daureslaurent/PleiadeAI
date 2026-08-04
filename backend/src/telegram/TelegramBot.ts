import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { sessionLock } from '../core/session/SessionLock';
import { agentRepository } from '../domain/agents/agent.repository';
import type { AgentDoc } from '../domain/agents/agent.model';
import { agentRunner, RunAbortedError } from '../orchestrator/AgentRunner';
import { resourceRepository } from '../domain/resources/resource.repository';
import type { ImageBlock } from '../core/event-bus/events.types';
import { chatSessions } from './session';
import {
  telegramClient,
  MAX_DOWNLOAD_BYTES,
  type BotCommand,
  type InlineButton,
  type TelegramFile,
  type TelegramUpdate,
} from './TelegramClient';
import { telegramChatIds } from './telegram-config';

const log = createLogger('telegram-bot');

/** Slash-command menu advertised in the Telegram client. */
const COMMANDS: BotCommand[] = [
  { command: 'start', description: 'Show the main menu' },
  { command: 'agents', description: 'Pick which agent to talk to' },
  { command: 'agent', description: 'Select an agent by name: /agent <name>' },
  { command: 'new', description: 'Start a fresh conversation' },
  { command: 'status', description: 'Show the active agent and state' },
  { command: 'cancel', description: 'Stop the running agent turn' },
  { command: 'help', description: 'How to use this bot' },
];

/**
 * The one file a message carries, and what to call it.
 *
 * Telegram splits media across many fields rather than a single typed union, and a photo arrives as
 * an array of re-encodings — the last is the largest, which is the only one worth analysing.
 */
function attachedFile(
  message: NonNullable<TelegramUpdate['message']>,
): { file: TelegramFile; kind: string; fallbackMime: string } | null {
  if (message.photo?.length) {
    return { file: message.photo[message.photo.length - 1]!, kind: 'photo', fallbackMime: 'image/jpeg' };
  }
  if (message.voice) return { file: message.voice, kind: 'voice', fallbackMime: 'audio/ogg' };
  if (message.audio) return { file: message.audio, kind: 'audio', fallbackMime: 'audio/mpeg' };
  if (message.video) return { file: message.video, kind: 'video', fallbackMime: 'video/mp4' };
  if (message.video_note) return { file: message.video_note, kind: 'video note', fallbackMime: 'video/mp4' };
  if (message.animation) return { file: message.animation, kind: 'animation', fallbackMime: 'video/mp4' };
  if (message.document) {
    return { file: message.document, kind: 'file', fallbackMime: 'application/octet-stream' };
  }
  return null;
}

/** One conversation per chat, so resources and handles accumulate across a chat's turns. */
const sessionIdFor = (chatId: number): string => `telegram-${chatId}`;

/**
 * Handles already in the session, so a reply can send only what the latest turn added. `null` means
 * the snapshot failed — the caller then sends nothing, since without a baseline the only safe
 * alternative would be re-sending the chat's entire history of media.
 */
async function sessionResourceHandles(sessionId: string): Promise<Set<string> | null> {
  try {
    const rows = await resourceRepository.listBySession(sessionId);
    return new Set(rows.map((r) => r.handle));
  } catch {
    return null;
  }
}

/** A filename extension for media Telegram gave no name to — from its mime, else its own path. */
function extensionFor(mime: string, telegramPath: string): string {
  const fromPath = telegramPath.split('.').pop();
  if (fromPath && fromPath.length <= 5 && !fromPath.includes('/')) return fromPath;
  const subtype = mime.split('/')[1] ?? 'bin';
  return subtype.replace(/[^a-z0-9]/gi, '') || 'bin';
}

/** Telegram server-side hold for a single long-poll (seconds). */
const POLL_TIMEOUT_SEC = 30;

/**
 * Interactive Telegram bot for the single operator. Long-polls the Bot API, routes commands and
 * inline-keyboard taps, and forwards free text to the selected agent through `agentRunner.run`
 * (headless, exactly like the cron path). Outbound completion alerts flow separately through
 * `alerts/telegram.service.ts`, which shares the same `TelegramClient`.
 */
class TelegramBot {
  private running = false;
  private offset = 0;
  private allowed: Set<string> = new Set();
  /** The active poll loop — awaited by `restart` so two loops never run concurrently. */
  private loop: Promise<void> | null = null;

  private computeAllowlist(): Set<string> {
    return new Set(telegramChatIds());
  }

  private isAllowed(chatId: number): boolean {
    // Empty allowlist ⇒ operator hasn't restricted chats; permit any (single-operator deployment).
    return this.allowed.size === 0 || this.allowed.has(String(chatId));
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!telegramClient.isConfigured()) {
      log.debug('telegram bot not configured; skipping');
      return;
    }
    if (!env.TELEGRAM_POLLING) {
      log.info('telegram polling disabled; alerts-only mode');
      return;
    }
    const me = await telegramClient.getMe();
    if (!me) {
      log.warn('telegram getMe failed; not starting bot (token invalid?)');
      return;
    }
    this.allowed = this.computeAllowlist();
    await telegramClient.setMyCommands(COMMANDS);
    this.running = true;
    log.info(
      { username: me.username, restricted: this.allowed.size > 0 },
      'telegram bot started',
    );
    this.loop = this.pollLoop();
  }

  stop(): void {
    this.running = false;
  }

  /**
   * Re-apply the runtime Telegram config (settings save): stop, let the in-flight long-poll
   * unwind (up to ~40s), then start again against the new token/allowlist. `start` no-ops if the
   * token was removed. Fire-and-forget from the settings route.
   */
  async restart(): Promise<void> {
    this.stop();
    await this.loop;
    this.loop = null;
    await this.start();
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const updates = await telegramClient.getUpdates(this.offset, POLL_TIMEOUT_SEC);
      for (const update of updates) {
        this.offset = update.update_id + 1;
        try {
          await this.dispatch(update);
        } catch (err) {
          log.error({ err, updateId: update.update_id }, 'telegram update handler failed');
        }
      }
    }
  }

  private async dispatch(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    // A photo/voice/video message carries its text in `caption`, and often no text at all — keying
    // on `.text` alone made the bot silently ignore every media message.
    if (update.message && (update.message.text || attachedFile(update.message)))
      return this.handleMessage(update.message);
  }

  // --- Message handling ---------------------------------------------------

  private async handleMessage(
    message: NonNullable<TelegramUpdate['message']>,
  ): Promise<void> {
    const chatId = message.chat.id;
    const text = (message.text ?? '').trim();
    if (!this.isAllowed(chatId)) {
      await telegramClient.sendMessage(
        chatId,
        `⛔ Not authorized.\nAsk the operator to add chat id \`${chatId}\` to the Telegram chat ids (Autonomy page, or TELEGRAM_ALLOWED_CHAT_IDS).`,
      );
      log.warn({ chatId, username: message.from?.username }, 'rejected unauthorized chat');
      return;
    }

    if (text.startsWith('/')) return this.handleCommand(chatId, text);

    const attached = attachedFile(message);
    if (attached) {
      const ingested = await this.ingestMedia(chatId, message, attached);
      if (!ingested) return;
      return this.runAgentTurn(chatId, ingested.text, ingested.images);
    }
    return this.runAgentTurn(chatId, text);
  }

  /**
   * Pull a file the user sent into the session's resource pool.
   *
   * Persisting rather than passing bytes straight through is what makes the media *usable*: it earns
   * an `img_N` / `blob_N` handle, so the agent can edit it, save it, or hand it to another agent, and
   * it stays referenceable on later turns ("now make it blue"). Telegram sessions keep no message
   * documents, so an un-persisted attachment would vanish the moment the turn ended.
   *
   * Returns the text to run the turn with, plus the image blocks a multimodal agent should see.
   */
  private async ingestMedia(
    chatId: number,
    message: NonNullable<TelegramUpdate['message']>,
    attached: NonNullable<ReturnType<typeof attachedFile>>,
  ): Promise<{ text: string; images: ImageBlock[] } | null> {
    const { file, kind, fallbackMime } = attached;
    const caption = (message.caption ?? message.text ?? '').trim();

    if ((file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
      await telegramClient.sendMessage(
        chatId,
        `⚠️ That ${kind} is ${(file.file_size! / 1024 / 1024).toFixed(1)}MB — Telegram only lets bots ` +
          `download up to ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB.`,
      );
      return null;
    }

    await telegramClient.sendChatAction(chatId, 'typing');
    const downloaded = await telegramClient.downloadFile(file.file_id);
    if (!downloaded) {
      await telegramClient.sendMessage(chatId, `⚠️ Could not download that ${kind} from Telegram.`);
      return null;
    }

    const mime = file.mime_type || fallbackMime;
    const isImage = mime.startsWith('image/');
    const filename =
      file.file_name || `${kind.replace(/\s+/g, '_')}_${Date.now()}.${extensionFor(mime, downloaded.path)}`;

    const agent = await this.resolveAgent(chatSessions.get(chatId).agentName);
    const stored = await resourceRepository.store({
      sessionId: sessionIdFor(chatId),
      agentId: agent ? String(agent._id) : '',
      bytes: downloaded.bytes,
      kind: isImage ? 'image' : 'blob',
      mime,
      filename,
      source: 'attachment',
    });

    const sizeMb = (downloaded.bytes.length / 1024 / 1024).toFixed(1);
    log.info({ chatId, kind, handle: stored.handle, mime, bytes: downloaded.bytes.length }, 'telegram media in');

    // Images ride into the turn as pixels so a multimodal agent simply sees them; audio and video
    // can't enter a model's context at all, so the agent gets the handle and a plain description.
    const images: ImageBlock[] = isImage
      ? [
          {
            id: stored.handle,
            kind: 'image',
            mime,
            size: downloaded.bytes.length,
            filename,
            storageId: String(stored.gridfs_id),
            source: 'attachment',
            dataUrl: `data:${mime};base64,${downloaded.bytes.toString('base64')}`,
          },
        ]
      : [];

    const note = isImage
      ? `[The user sent an image, saved as \`${stored.handle}\`. Use that handle for \`edit_image\`, \`write from_handle\` or \`data\`.]`
      : `[The user sent ${
          kind === 'voice' ? 'a voice message' : `a ${kind}`
        } (${mime}, ${sizeMb}MB), saved as \`${stored.handle}\`. You cannot listen to or watch it — ` +
        `work with it by handle (\`data\`, \`write from_handle\`) or hand it to a tool that can.]`;

    return { text: caption ? `${caption}\n\n${note}` : note, images };
  }

  /**
   * Deliver whatever the turn produced — a generated image, a rendered clip, a fetched PDF — as real
   * Telegram media rather than leaving the operator with a handle they can only see in the web UI.
   *
   * Sent one at a time and best-effort: a single oversized video must not cost the user the picture
   * that rendered alongside it.
   */
  private async sendNewResources(
    chatId: number,
    sessionId: string,
    before: Set<string> | null,
  ): Promise<void> {
    if (!before) return;
    let rows: Awaited<ReturnType<typeof resourceRepository.listBySession>>;
    try {
      rows = await resourceRepository.listBySession(sessionId);
    } catch (err) {
      log.warn({ err, chatId }, 'could not list session resources for telegram reply');
      return;
    }

    for (const row of rows) {
      if (before.has(row.handle)) continue;
      // The user sent this to us moments ago; echoing it back is noise.
      if (row.source === 'attachment') continue;
      try {
        const bytes = await resourceRepository.readBytes(sessionId, row.handle);
        if (!bytes) continue;
        const ok = await telegramClient.sendMedia(
          chatId,
          { bytes, filename: row.filename || row.handle, mime: row.mime || 'application/octet-stream' },
          { caption: row.handle },
        );
        if (!ok) {
          await telegramClient.sendMessage(
            chatId,
            `⚠️ Couldn't send \`${row.handle}\` (${row.mime}, ${(row.size / 1024 / 1024).toFixed(1)}MB) — it's available in the web UI.`,
          );
        }
      } catch (err) {
        log.warn({ err, chatId, handle: row.handle }, 'failed to send resource to telegram');
      }
    }
  }

  private async handleCommand(chatId: number, text: string): Promise<void> {
    const [raw = '', ...rest] = text.split(/\s+/);
    // Strip the leading slash and the @botname suffix Telegram appends in groups.
    const cmd = (raw.slice(1).split('@')[0] ?? '').toLowerCase();
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case 'start':
        return this.sendMainMenu(chatId);
      case 'help':
        return this.sendHelp(chatId);
      case 'agents':
        return this.sendAgentPicker(chatId);
      case 'agent':
        return arg
          ? this.selectAgent(chatId, arg)
          : this.sendAgentPicker(chatId);
      case 'new':
        chatSessions.reset(chatId);
        return telegramClient.sendMessage(chatId, '🆕 Started a fresh conversation.');
      case 'status':
        return this.sendStatus(chatId);
      case 'cancel':
        return this.cancelRun(chatId);
      default:
        return telegramClient.sendMessage(
          chatId,
          `Unknown command \`/${cmd}\`. Try /help.`,
        );
    }
  }

  private async runAgentTurn(chatId: number, text: string, images: ImageBlock[] = []): Promise<void> {
    const session = chatSessions.get(chatId);
    if (session.running) {
      await telegramClient.sendMessage(
        chatId,
        '⏳ The agent is still working. Send /cancel to stop it.',
      );
      return;
    }

    const agent = await this.resolveAgent(session.agentName);
    if (!agent) {
      await telegramClient.sendMessage(
        chatId,
        'No agents exist yet. Create one in the web UI first.',
      );
      return;
    }
    // Lazily bind the default agent so /status and history reflect the real selection.
    session.agentName = agent.name;

    const agentId = String(agent._id);
    const abort = new AbortController();
    session.running = true;
    session.abort = abort;
    sessionLock.acquireUserSession(agentId);

    const sessionId = sessionIdFor(chatId);
    try {
      await telegramClient.sendChatAction(chatId, 'typing');
      // Keep the typing indicator alive across a long turn (Telegram clears it after ~5s).
      const keepTyping = setInterval(
        () => void telegramClient.sendChatAction(chatId, 'typing'),
        4000,
      );

      // Which resources already existed, so the reply carries only what *this* turn produced. The
      // session pool accumulates across the whole chat, so sending "everything" would re-send every
      // earlier picture on each message.
      const before = await sessionResourceHandles(sessionId);

      let answer: string;
      try {
        answer = (
          await agentRunner.run({
            agentName: agent.name,
            sessionId,
            depth: 0,
            userText: text,
            images,
            history: session.history,
            signal: abort.signal,
          })
        ).text;
      } finally {
        clearInterval(keepTyping);
      }

      session.history.push({ role: 'user', content: text });
      session.history.push({ role: 'assistant', content: answer });
      await telegramClient.sendMessage(chatId, answer);
      await this.sendNewResources(chatId, sessionId, before);
    } catch (err) {
      if (err instanceof RunAbortedError) {
        await telegramClient.sendMessage(chatId, '🛑 Stopped.');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err, agent: agent.name, chatId }, 'telegram agent turn failed');
        await telegramClient.sendMessage(chatId, `⚠️ Error: ${msg}`);
      }
    } finally {
      session.running = false;
      session.abort = undefined;
      sessionLock.releaseUserSession(agentId);
    }
  }

  private cancelRun(chatId: number): Promise<void> {
    const session = chatSessions.get(chatId);
    if (session.running && session.abort) {
      session.abort.abort();
      return Promise.resolve();
    }
    return telegramClient.sendMessage(chatId, 'Nothing is running.');
  }

  // --- Callback (inline keyboard) handling --------------------------------

  private async handleCallback(
    query: NonNullable<TelegramUpdate['callback_query']>,
  ): Promise<void> {
    const chatId = query.message?.chat.id;
    if (chatId === undefined) return;
    await telegramClient.answerCallbackQuery(query.id);
    if (!this.isAllowed(chatId)) return;

    const data = query.data ?? '';
    if (data === 'menu') return this.sendMainMenu(chatId);
    if (data === 'agents') return this.sendAgentPicker(chatId);
    if (data === 'help') return this.sendHelp(chatId);
    if (data === 'status') return this.sendStatus(chatId);
    if (data === 'new') {
      chatSessions.reset(chatId);
      return telegramClient.sendMessage(chatId, '🆕 Started a fresh conversation.');
    }
    if (data.startsWith('agent:')) return this.selectAgent(chatId, data.slice('agent:'.length));
  }

  // --- Menu / view builders ----------------------------------------------

  private async sendMainMenu(chatId: number): Promise<void> {
    const keyboard: InlineButton[][] = [
      [
        { text: '🤖 Agents', callback_data: 'agents' },
        { text: '🆕 New chat', callback_data: 'new' },
      ],
      [
        { text: '📊 Status', callback_data: 'status' },
        { text: 'ℹ️ Help', callback_data: 'help' },
      ],
    ];
    await telegramClient.sendMessage(
      chatId,
      '*PleiadesAI command center*\nPick an agent, then just send messages to chat with it.',
      { keyboard },
    );
  }

  private async sendAgentPicker(chatId: number): Promise<void> {
    const agents = await agentRepository.list();
    if (agents.length === 0) {
      await telegramClient.sendMessage(chatId, 'No agents exist yet. Create one in the web UI.');
      return;
    }
    const current = chatSessions.get(chatId).agentName;
    const keyboard: InlineButton[][] = agents.map((a) => [
      {
        text: `${a.name === current ? '✅ ' : ''}${a.name}${a.subagent ? ' (sub)' : ''}`,
        callback_data: `agent:${a.name}`,
      },
    ]);
    keyboard.push([{ text: '⬅️ Menu', callback_data: 'menu' }]);
    await telegramClient.sendMessage(chatId, '*Choose an agent:*', { keyboard });
  }

  private async selectAgent(chatId: number, name: string): Promise<void> {
    const agent = await agentRepository.findByName(name);
    if (!agent) {
      await telegramClient.sendMessage(chatId, `No agent named \`${name}\`. Try /agents.`);
      return;
    }
    chatSessions.setAgent(chatId, agent.name);
    const desc = agent.description ? `\n_${agent.description}_` : '';
    await telegramClient.sendMessage(
      chatId,
      `✅ Talking to *${agent.name}*.${desc}\nSend a message to begin.`,
    );
  }

  private async sendStatus(chatId: number): Promise<void> {
    const session = chatSessions.get(chatId);
    const agent = session.agentName ?? '_(default — none picked)_';
    const state = session.running ? '🟢 running' : '⚪ idle';
    await telegramClient.sendMessage(
      chatId,
      `*Status*\nAgent: *${agent}*\nState: ${state}\nHistory: ${session.history.length / 2} turn(s)`,
    );
  }

  private async sendHelp(chatId: number): Promise<void> {
    await telegramClient.sendMessage(
      chatId,
      [
        '*How to use this bot*',
        '',
        '• /agents — pick which agent to talk to',
        '• /agent <name> — select an agent directly',
        '• Just type a message to chat with the selected agent',
        '• /new — start a fresh conversation (clears history)',
        '• /status — show the active agent and state',
        '• /cancel — stop a running agent turn',
        '',
        '*Media*',
        '• Send a photo, voice note, video or file — the agent receives it and can edit,',
        '  save or pass it on. Add a caption to say what you want done with it.',
        '• Images, clips and sound the agent produces come back here as media.',
        '',
        'Completion alerts from autonomous tasks are also delivered here.',
      ].join('\n'),
    );
  }

  /** Resolve the selected agent, or fall back to the first top-level agent. */
  private async resolveAgent(name?: string): Promise<AgentDoc | null> {
    if (name) return agentRepository.findByName(name);
    const agents = await agentRepository.list();
    return agents.find((a) => !a.subagent) ?? agents[0] ?? null;
  }
}

export const telegramBot = new TelegramBot();
