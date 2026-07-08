import { Types } from 'mongoose';
import { NotificationModel, type NotificationDoc } from './notification.model';

export const notificationRepository = {
  /** `agent_id` may be null for system-level notifications not owned by any agent. */
  create(input: {
    agent_id?: string | Types.ObjectId | null;
    title: string;
    content: string;
  }): Promise<NotificationDoc> {
    return NotificationModel.create({ ...input, status: 'unread' });
  },

  /** Inbox listing, newest first. Optionally scoped to one agent. */
  list(opts: { agentId?: string | Types.ObjectId; unreadOnly?: boolean } = {}): Promise<
    NotificationDoc[]
  > {
    const filter: Record<string, unknown> = {};
    if (opts.agentId) filter.agent_id = opts.agentId;
    if (opts.unreadOnly) filter.status = 'unread';
    return NotificationModel.find(filter).sort({ created_at: -1 }).exec();
  },

  countUnread(agentId?: string | Types.ObjectId): Promise<number> {
    const filter: Record<string, unknown> = { status: 'unread' };
    if (agentId) filter.agent_id = agentId;
    return NotificationModel.countDocuments(filter).exec();
  },

  markRead(id: string | Types.ObjectId): Promise<NotificationDoc | null> {
    return NotificationModel.findByIdAndUpdate(
      id,
      { $set: { status: 'read' } },
      { new: true },
    ).exec();
  },

  markAllRead(agentId?: string | Types.ObjectId): Promise<number> {
    const filter: Record<string, unknown> = { status: 'unread' };
    if (agentId) filter.agent_id = agentId;
    return NotificationModel.updateMany(filter, { $set: { status: 'read' } })
      .exec()
      .then((r) => r.modifiedCount);
  },
};
