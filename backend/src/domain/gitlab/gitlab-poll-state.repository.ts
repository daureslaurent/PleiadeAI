import { GitLabPollStateModel, type GitLabPollStateDoc } from './gitlab-poll-state.model';

/** How many tie-breaker ids are kept beside a cursor — a busy second, not a busy day. */
const MAX_TIE_IDS = 50;

export interface PollCursor {
  /** `null` means this source has never been read: the tick baselines it and wakes nobody. */
  cursor: Date | null;
  cursorIds: string[];
  cursorId: number;
}

export const gitlabPollStateRepository = {
  async get(key: string): Promise<PollCursor | null> {
    const doc = await GitLabPollStateModel.findOne({ key }).lean<GitLabPollStateDoc>();
    if (!doc) return null;
    return {
      cursor: doc.cursor ?? null,
      cursorIds: doc.cursor_ids ?? [],
      cursorId: doc.cursor_id ?? 0,
    };
  },

  async set(key: string, next: Partial<PollCursor>): Promise<void> {
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (next.cursor !== undefined) patch.cursor = next.cursor;
    if (next.cursorIds !== undefined) patch.cursor_ids = next.cursorIds.slice(0, MAX_TIE_IDS);
    if (next.cursorId !== undefined) patch.cursor_id = next.cursorId;
    await GitLabPollStateModel.updateOne({ key }, { $set: patch }, { upsert: true }).exec();
  },

  /**
   * Forget every cursor. What the settings page calls "re-baseline": after a long pause the stored
   * cursors point at a backlog nobody wants replayed, and the honest reset is to start from now.
   */
  async clear(): Promise<void> {
    await GitLabPollStateModel.deleteMany({}).exec();
  },
};
