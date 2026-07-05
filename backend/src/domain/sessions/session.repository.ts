import { Types } from 'mongoose';
import { SessionModel, type SessionDoc } from './session.model';
import { MessageModel, type MessageDoc } from './message.model';

/** Truncate the first user message into a readable session title. */
function deriveTitle(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean || 'New session';
}

/**
 * Data-access for conversation sessions and their messages. The transport layer and the WS
 * handler go through here so the persistence shape stays in one place.
 */
export const sessionRepository = {
  listByAgent(agentId: string | Types.ObjectId): Promise<SessionDoc[]> {
    return SessionModel.find({ agent_id: agentId }).sort({ updated_at: -1 }).exec();
  },

  findById(id: string | Types.ObjectId): Promise<SessionDoc | null> {
    return SessionModel.findById(id).exec();
  },

  create(input: { agentId: string | Types.ObjectId; agentName: string; title?: string }): Promise<SessionDoc> {
    return SessionModel.create({
      agent_id: input.agentId,
      agent_name: input.agentName,
      title: input.title ?? 'New session',
    });
  },

  /**
   * Set a session's title. `auto` records provenance: the auto-titler passes `true` (the title may
   * still be refined as the chat grows), a manual/user rename passes `false` to freeze it.
   */
  rename(id: string | Types.ObjectId, title: string, auto = false): Promise<SessionDoc | null> {
    return SessionModel.findByIdAndUpdate(
      id,
      { $set: { title, title_auto: auto } },
      { new: true },
    ).exec();
  },

  /** Bump `updated_at` so recently-used sessions float to the top of the list. */
  touch(id: string | Types.ObjectId): Promise<unknown> {
    return SessionModel.findByIdAndUpdate(id, { $set: { updated_at: new Date() } }).exec();
  },

  async delete(id: string | Types.ObjectId): Promise<SessionDoc | null> {
    await MessageModel.deleteMany({ session_id: id }).exec();
    return SessionModel.findByIdAndDelete(id).exec();
  },

  messages(sessionId: string | Types.ObjectId): Promise<MessageDoc[]> {
    return MessageModel.find({ session_id: sessionId }).sort({ created_at: 1 }).exec();
  },

  /**
   * Append a turn. On the first user message of an untitled session, derive the title so the
   * session list reads meaningfully. Always bumps the session's `updated_at`.
   */
  async addMessage(
    sessionId: string | Types.ObjectId,
    input: {
      role: 'user' | 'assistant';
      text?: string;
      blocks?: unknown;
      reasoning?: string;
      trace?: unknown;
      context_tokens?: number;
      context_window?: number;
    },
  ): Promise<MessageDoc> {
    const msg = await MessageModel.create({ session_id: sessionId, ...input });

    const session = await SessionModel.findById(sessionId).exec();
    if (session) {
      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (input.role === 'user' && (!session.title || session.title === 'New session') && input.text) {
        patch.title = deriveTitle(input.text);
      }
      await SessionModel.findByIdAndUpdate(sessionId, { $set: patch }).exec();
    }
    return msg;
  },
};
