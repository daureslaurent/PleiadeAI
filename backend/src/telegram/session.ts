import type { ChatMessage } from '../domain/agents/jit-builder';

/**
 * In-memory conversation state for one Telegram chat. PleiadesAI is single-operator, so keeping
 * this in process (and losing it on restart) is an acceptable trade for zero persistence overhead;
 * the durable record of an exchange is the agent's own Qdrant memory.
 */
export interface ChatSession {
  chatId: number;
  /** Currently selected agent, or undefined until one is chosen (defaults are applied lazily). */
  agentName?: string;
  /** Prior turns for the selected agent (user/assistant pairs), excluding the in-flight message. */
  history: ChatMessage[];
  /** Set while an agent turn is running so `/cancel` can abort it and text is queued/ignored. */
  running: boolean;
  abort?: AbortController;
}

const sessions = new Map<number, ChatSession>();

export const chatSessions = {
  get(chatId: number): ChatSession {
    let s = sessions.get(chatId);
    if (!s) {
      s = { chatId, history: [], running: false };
      sessions.set(chatId, s);
    }
    return s;
  },

  /** Switch the active agent and wipe history — a fresh conversation with the new agent. */
  setAgent(chatId: number, agentName: string): void {
    const s = this.get(chatId);
    s.agentName = agentName;
    s.history = [];
  },

  /** Clear the conversation for the current agent, keeping the selection. */
  reset(chatId: number): void {
    const s = this.get(chatId);
    s.history = [];
  },
};
