/**
 * In-process state for one Telegram chat: which agent it talks to, and which conversation.
 *
 * The conversation itself is an ordinary persisted session (`origin: 'telegram'`), so it shows in the
 * agent's Workspace list and survives a restart. Only the pointer lives here — and when it is lost
 * (a restart), the bot resumes the chat's newest conversation with the agent unless `/new` said not to.
 */
export interface ChatSession {
  chatId: number;
  /** Currently selected agent, or undefined until one is chosen (defaults are applied lazily). */
  agentName?: string;
  /** The persisted conversation this chat is in, once resolved for the selected agent. */
  sessionId?: string;
  /** Set by `/new` and an agent switch: the next message opens a conversation instead of resuming one. */
  fresh: boolean;
  /** Set while an agent turn is running so `/cancel` can abort it and text is queued/ignored. */
  running: boolean;
  abort?: AbortController;
}

const sessions = new Map<number, ChatSession>();

export const chatSessions = {
  get(chatId: number): ChatSession {
    let s = sessions.get(chatId);
    if (!s) {
      s = { chatId, fresh: false, running: false };
      sessions.set(chatId, s);
    }
    return s;
  },

  /** Switch the active agent — a fresh conversation with the new agent. */
  setAgent(chatId: number, agentName: string): void {
    const s = this.get(chatId);
    s.agentName = agentName;
    s.sessionId = undefined;
    s.fresh = true;
  },

  /** Start a fresh conversation with the current agent, keeping the selection. */
  reset(chatId: number): void {
    const s = this.get(chatId);
    s.sessionId = undefined;
    s.fresh = true;
  },
};
