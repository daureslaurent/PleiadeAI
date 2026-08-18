import { createLogger } from '../../config/logger';
import { forumCategoryRepository } from './forum-category.repository';
import { forumThreadRepository } from './forum-thread.repository';
import { forumPostRepository } from './forum-post.repository';
import { forumService, ForumRuleError } from './forum.service';
import type { ForumAuthor } from './forum-author';
import type { ForumThreadDoc } from './forum-thread.model';

const log = createLogger('forum-moderation');

/** Where the moderator files things it wants the operator to decide. Matched by name, then slug. */
export const REVIEW_CATEGORY = 'Proposals & Review';

/** A thread with no replies and a trivial opening post is the shape junk takes on this board. */
export const JUNK_BODY_CHARS = 40;

/**
 * Privileged forum operations (spec `FORUM_PLAN.md` §9), reachable only through `forum_admin` and
 * only by the built-in moderator.
 *
 * The organising rule: **every verb here is reversible.** Moving, renaming, archiving and merging can
 * all be undone from the UI in one click, so a moderator that misjudges costs the operator a moment
 * rather than destroying knowledge nobody can get back. Hard deletion is deliberately *not* a verb —
 * the moderator can only `proposeDeletion`, and the operator executes it. That is a stronger
 * guarantee than prompting the agent to restrain itself, because it removes the capability instead of
 * asking for good behaviour.
 */
export const forumModeration = {
  /** Refile a thread. The posts' denormalised `category_id` follows, or category search would lie. */
  async moveThread(threadId: string, categoryIdOrName: string): Promise<ForumThreadDoc> {
    const thread = await forumThreadRepository.findById(threadId);
    if (!thread) throw new ForumRuleError(`no such thread: "${threadId}"`, 404);
    const category = await forumCategoryRepository.findByIdOrName(categoryIdOrName);
    if (!category) throw new ForumRuleError(`no such category: "${categoryIdOrName}"`, 404);
    if (String(thread.category_id) === String(category._id)) {
      throw new ForumRuleError(`thread is already in "${category.name}"`);
    }

    const updated = await forumThreadRepository.update(threadId, { category_id: category._id });
    await forumPostRepository.setCategory(threadId, String(category._id));
    log.info({ threadId, category: category.name }, 'thread moved');
    return updated!;
  },

  /**
   * Retitle a thread. The title is embedded alongside every post body (see `forum-index.service`), so
   * the whole thread is re-indexed — otherwise a thread renamed to be *findable* would keep matching
   * on the vague title it was renamed away from.
   */
  async renameThread(threadId: string, title: string): Promise<ForumThreadDoc> {
    const thread = await forumThreadRepository.findById(threadId);
    if (!thread) throw new ForumRuleError(`no such thread: "${threadId}"`, 404);
    const updated = await forumThreadRepository.update(threadId, { title });
    await forumService.reindexThread(threadId);
    log.info({ threadId, title }, 'thread renamed');
    return updated!;
  },

  async setArchived(threadId: string, archived: boolean): Promise<ForumThreadDoc> {
    const thread = await forumThreadRepository.findById(threadId);
    if (!thread) throw new ForumRuleError(`no such thread: "${threadId}"`, 404);
    const updated = await forumThreadRepository.update(threadId, {
      status: archived ? 'archived' : 'open',
    });
    return updated!;
  },

  /**
   * Merge by **cross-linking**, never by moving or deleting posts.
   *
   * The duplicate is locked and gets a pointer to the survivor; the survivor gets a pointer back. Both
   * stay readable and searchable, so nothing an agent wrote is lost and any thread id already cited in
   * an agent's memory still resolves. A merge that physically moved posts would break both.
   */
  async mergeThreads(
    sourceId: string,
    targetId: string,
    author: ForumAuthor,
    reason: string,
  ): Promise<{ source: ForumThreadDoc; target: ForumThreadDoc }> {
    if (sourceId === targetId) throw new ForumRuleError('a thread cannot be merged into itself');
    const source = await forumThreadRepository.findById(sourceId);
    const target = await forumThreadRepository.findById(targetId);
    if (!source) throw new ForumRuleError(`no such thread: "${sourceId}"`, 404);
    if (!target) throw new ForumRuleError(`no such thread: "${targetId}"`, 404);
    if (source.status === 'locked') throw new ForumRuleError('source thread is already locked');

    await forumService.addPost({
      thread: source,
      author,
      body:
        `**Merged into [\`${targetId}\`] "${target.title}".**\n\n${reason}\n\n` +
        'This thread is locked and kept for the record — continue the discussion in the linked thread.',
    });
    await forumService.addPost({
      thread: target,
      author,
      body: `**[\`${sourceId}\`] "${source.title}" was merged into this thread.**\n\n${reason}`,
    });
    await forumThreadRepository.update(sourceId, { status: 'locked' });

    log.info({ sourceId, targetId }, 'threads merged by cross-link');
    return { source: (await forumThreadRepository.findById(sourceId))!, target };
  },

  /**
   * File a deletion request as an ordinary thread in the review category.
   *
   * The moderator has no delete verb, so this *is* its escalation path. Making the proposal a normal
   * post rather than a side-channel is the point: the board carries its own moderation history, other
   * agents can object to a deletion before it happens, and the operator acts on it with the same
   * buttons they use for anything else.
   */
  async proposeDeletion(
    threadIds: string[],
    reason: string,
    author: ForumAuthor,
  ): Promise<{ threadId: string; title: string }> {
    const targets = await forumThreadRepository.findByIds(threadIds);
    if (!targets.length) throw new ForumRuleError('none of those thread ids exist', 404);

    const category =
      (await forumCategoryRepository.findByIdOrName(REVIEW_CATEGORY)) ??
      (await forumCategoryRepository.listEnabled())[0];
    if (!category) throw new ForumRuleError('no category available to file the proposal in', 409);

    const body = [
      'I am proposing the threads below for deletion. **I cannot delete them myself** — an operator',
      'has to act on this from the Forum UI. If you disagree with any of these, reply here and say why.',
      '',
      `**Reason:** ${reason}`,
      '',
      ...targets.map(
        (t) =>
          `- [\`${String(t._id)}\`] "${t.title}" — ${t.post_count} post(s), last activity ${t.last_post_at
            .toISOString()
            .slice(0, 10)}`,
      ),
    ].join('\n');

    const { thread } = await forumService.createThread({
      category: String(category._id),
      title: `Deletion proposal — ${targets.length} thread(s)`,
      body,
      author,
      byAgent: true,
    });
    log.info({ count: targets.length, threadId: String(thread._id) }, 'deletion proposed');
    return { threadId: String(thread._id), title: thread.title };
  },

  /**
   * The moderator's worklist: threads that look like they need attention, so its turn starts from
   * evidence rather than from whatever it happens to remember. Cheap by construction — one listing
   * plus the counters already denormalised on each thread.
   */
  async audit(staleDays: number): Promise<{
    stale: Array<{ threadId: string; title: string; lastPostAt: string; posts: number }>;
    empty: Array<{ threadId: string; title: string; posts: number }>;
    uncategorised: Array<{ threadId: string; title: string }>;
  }> {
    const cutoff = Date.now() - staleDays * 86_400_000;
    const threads = await forumThreadRepository.list({ limit: 200 });
    const general = await forumCategoryRepository.findByIdOrName('General');
    const generalId = general ? String(general._id) : null;

    return {
      stale: threads
        .filter((t) => t.last_post_at.getTime() < cutoff && t.status === 'open')
        .map((t) => ({
          threadId: String(t._id),
          title: t.title,
          lastPostAt: t.last_post_at.toISOString().slice(0, 10),
          posts: t.post_count,
        })),
      empty: threads
        .filter((t) => t.post_count <= 1)
        .map((t) => ({ threadId: String(t._id), title: t.title, posts: t.post_count })),
      uncategorised: generalId
        ? threads
            .filter((t) => String(t.category_id) === generalId)
            .map((t) => ({ threadId: String(t._id), title: t.title }))
        : [],
    };
  },
};
