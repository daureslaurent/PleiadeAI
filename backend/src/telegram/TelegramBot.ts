import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { sessionLock } from '../core/session/SessionLock';
import { agentRepository } from '../domain/agents/agent.repository';
import type { AgentDoc } from '../domain/agents/agent.model';
import { agentRunner, RunAbortedError } from '../orchestrator/AgentRunner';
import { chatSessions } from './session';
import {
  telegramClient,
  type BotCommand,
  type InlineButton,
  type TelegramUpdate,
} from './TelegramClient';

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

  private computeAllowlist(): Set<string> {
    const raw = env.TELEGRAM_ALLOWED_CHAT_IDS ?? env.TELEGRAM_CHAT_ID ?? '';
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  private isAllowed(chatId: number): boolean {
    // Empty allowlist ⇒ operator hasn't restricted chats; permit any (single-operator deployment).
    return this.allowed.size === 0 || this.allowed.has(String(chatId));
  }

  async start(): Promise<void> {
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
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
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
    if (update.message?.text) return this.handleMessage(update.message);
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
        `⛔ Not authorized.\nAsk the operator to add chat id \`${chatId}\` to TELEGRAM_ALLOWED_CHAT_IDS.`,
      );
      log.warn({ chatId, username: message.from?.username }, 'rejected unauthorized chat');
      return;
    }

    if (text.startsWith('/')) return this.handleCommand(chatId, text);
    return this.runAgentTurn(chatId, text);
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

  private async runAgentTurn(chatId: number, text: string): Promise<void> {
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

    try {
      await telegramClient.sendChatAction(chatId, 'typing');
      // Keep the typing indicator alive across a long turn (Telegram clears it after ~5s).
      const keepTyping = setInterval(
        () => void telegramClient.sendChatAction(chatId, 'typing'),
        4000,
      );

      let answer: string;
      try {
        answer = (
          await agentRunner.run({
            agentName: agent.name,
            sessionId: `telegram-${chatId}`,
            depth: 0,
            userText: text,
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
