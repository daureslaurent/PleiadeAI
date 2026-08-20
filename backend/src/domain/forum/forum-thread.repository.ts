import { Types } from 'mongoose';
import { ForumThreadModel, type ForumThreadDoc, type ForumWorkState } from './forum-thread.model';
import type { ForumAuthor } from './forum-author';

export interface CreateForumThreadInput {
  category_id: Types.ObjectId | string;
  title: string;
  author: ForumAuthor;
  tags?: string[];
}

export interface ListThreadsOptions {
  categoryId?: string;
  /** Archived threads are hidden unless asked for. */
  includeArchived?: boolean;
  /** Restrict to work items in these states. `'none'` selects threads that are not work items. */
  workState?: Array<ForumWorkState | 'none'>;
  /** Restrict to work items owned by this display name (case-insensitive). */
  assignee?: string;
  limit?: number;
}

/**
 * What is left of a thread's automatic-reply budget, in the form the UI and the tools both show.
 *
 * Derived rather than stored: the budget and the window length are Settings the operator can change
 * at any moment, and a stored remainder computed against yesterday's ceiling would be a lie the
 * moment they did.
 */
export interface AutoRunBudget {
  spent: number;
  budget: number;
  remaining: number;
  /** When the window rolls over and the count resets. Null when windowing is off (budget is a cap). */
  resetsAt: Date | null;
  exhausted: boolean;
}

/** `0` disables windowing, restoring the original lifetime cap. */
export function autoRunWindowMs(windowHours: number): number {
  return Math.max(0, windowHours) * 3_600_000;
}

export function autoRunBudget(
  thread: Pick<ForumThreadDoc, 'auto_run_count' | 'auto_run_window_start'>,
  budget: number,
  windowMs: number,
): AutoRunBudget {
  const start = thread.auto_run_window_start ? thread.auto_run_window_start.getTime() : 0;
  // A stale window is already spent from the reader's point of view: the next claim resets it, so
  // reporting yesterday's count would show a thread as blocked when it is about to run fine.
  const stale = windowMs > 0 && Date.now() - start >= windowMs;
  const spent = stale ? 0 : thread.auto_run_count ?? 0;
  return {
    spent,
    budget,
    remaining: Math.max(0, budget - spent),
    resetsAt: windowMs > 0 && !stale && start ? new Date(start + windowMs) : null,
    exhausted: spent >= budget,
  };
}

/** Neutralise a caller-supplied name before it becomes an anchored case-insensitive match. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Clamp any caller-supplied page size — an agent asking for 10_000 threads must not get them. */
function clamp(limit: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, Math.trunc(limit ?? fallback) || fallback));
}

export const forumThreadRepository = {
  list(opts: ListThreadsOptions = {}): Promise<ForumThreadDoc[]> {
    const filter: Record<string, unknown> = {};
    if (opts.categoryId && Types.ObjectId.isValid(opts.categoryId)) filter.category_id = opts.categoryId;
    if (!opts.includeArchived) filter.status = { $ne: 'archived' };
    if (opts.workState?.length) {
      // `'none'` has to become an explicit null match: threads written before work states existed
      // have no such field at all, and `$in: [null]` matches both missing and null.
      const states = opts.workState.filter((s) => s !== 'none');
      filter.work_state = opts.workState.includes('none') ? { $in: [...states, null] } : { $in: states };
    }
    if (opts.assignee) {
      filter['assignee.display_name'] = new RegExp(`^${escapeRegex(opts.assignee)}$`, 'i');
    }
    return ForumThreadModel.find(filter)
      .sort({ pinned: -1, last_post_at: -1 })
      .limit(clamp(opts.limit, 50, 200))
      .exec();
  },

  findById(id: string): Promise<ForumThreadDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumThreadModel.findById(id).exec();
  },

  findByIds(ids: string[]): Promise<ForumThreadDoc[]> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id));
    if (!valid.length) return Promise.resolve([]);
    return ForumThreadModel.find({ _id: { $in: valid } }).exec();
  },

  /** The keyword half of hybrid search: Mongo `$text` over thread titles. */
  searchByText(query: string, categoryId: string | undefined, limit: number): Promise<ForumThreadDoc[]> {
    const filter: Record<string, unknown> = { $text: { $search: query } };
    if (categoryId && Types.ObjectId.isValid(categoryId)) filter.category_id = categoryId;
    // MongoDB ≥4.4 ranks by text score without it being projected, which keeps the query typed.
    return ForumThreadModel.find(filter)
      .sort({ score: { $meta: 'textScore' } })
      .limit(clamp(limit, 10, 50))
      .exec();
  },

  create(input: CreateForumThreadInput): Promise<ForumThreadDoc> {
    return ForumThreadModel.create({
      ...input,
      last_post_at: new Date(),
      last_post_author: input.author.display_name,
    });
  },

  update(id: string, patch: Record<string, unknown>): Promise<ForumThreadDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumThreadModel.findByIdAndUpdate(
      id,
      { $set: { ...patch, updated_at: new Date() } },
      { new: true },
    ).exec();
  },

  /**
   * Record a new reply on the thread in one atomic operation. `$inc` rather than read-modify-write
   * because two agents can be mid-turn on the same thread and a lost update would show the wrong
   * reply count forever.
   */
  registerPost(id: Types.ObjectId | string, authorName: string, at: Date): Promise<ForumThreadDoc | null> {
    return ForumThreadModel.findByIdAndUpdate(
      id,
      { $inc: { post_count: 1 }, $set: { last_post_at: at, last_post_author: authorName, updated_at: at } },
      { new: true },
    ).exec();
  },

  /**
   * Spend one unit of the thread's automatic-run budget, or refuse.
   *
   * Conditional writes rather than read-then-write: several agents mentioned in one post are queued
   * back to back, and two of them checking a stale count is exactly how a budget meant to stop a
   * runaway exchange lets one through. `null` means the thread is out of budget (or gone) and the
   * mention stays pending for the operator to run by hand.
   *
   * Two conditional updates rather than one, because the budget rolls: the first claims a *fresh*
   * window if the current one has aged out, the second spends from a window still running. Each is
   * atomic on its own, and the order matters — trying the reset first means a thread that is both
   * stale and exhausted rolls over instead of being refused. A race between the two only ever costs
   * one unit, which is the same as any other concurrent claim.
   *
   * `windowMs === 0` disables rolling entirely and the second update alone reproduces the original
   * lifetime cap.
   */
  async claimAutoRun(id: Types.ObjectId | string, budget: number, windowMs: number): Promise<number | null> {
    if (!Types.ObjectId.isValid(String(id))) return null;
    const now = new Date();

    if (windowMs > 0) {
      const cutoff = new Date(now.getTime() - windowMs);
      const rolled = await ForumThreadModel.findOneAndUpdate(
        // `$eq: null` also matches the field being absent, which is every thread that predates
        // windowing and every thread that has never auto-replied. Both want a fresh window.
        { _id: id, $or: [{ auto_run_window_start: { $lte: cutoff } }, { auto_run_window_start: null }] },
        { $set: { auto_run_count: 1, auto_run_window_start: now, auto_run_notified_at: null } },
        { new: true },
      ).exec();
      if (rolled) return rolled.auto_run_count;
    }

    const doc = await ForumThreadModel.findOneAndUpdate(
      { _id: id, auto_run_count: { $lt: budget } },
      { $inc: { auto_run_count: 1 } },
      { new: true },
    ).exec();
    return doc ? doc.auto_run_count : null;
  },

  /**
   * Claim the right to raise *one* alert about this thread being out of budget, for this window.
   *
   * Conditional on the stamp being unset so a thread that is being mentioned every minute produces
   * one notification rather than a stream of them; `claimAutoRun` clears the stamp when it opens a
   * fresh window, so the next exhaustion is announced again.
   */
  async claimAutoRunNotice(id: Types.ObjectId | string): Promise<boolean> {
    if (!Types.ObjectId.isValid(String(id))) return false;
    const doc = await ForumThreadModel.findOneAndUpdate(
      { _id: id, auto_run_notified_at: null },
      { $set: { auto_run_notified_at: new Date() } },
    ).exec();
    return Boolean(doc);
  },

  incrementViews(id: string): Promise<unknown> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumThreadModel.updateOne({ _id: id }, { $inc: { view_count: 1 } }).exec();
  },

  countByCategory(categoryId: Types.ObjectId | string): Promise<number> {
    return ForumThreadModel.countDocuments({ category_id: categoryId }).exec();
  },

  async remove(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    return Boolean(await ForumThreadModel.findByIdAndDelete(id).exec());
  },
};
