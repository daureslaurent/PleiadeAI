import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import { alertEngine } from '../../alerts/AlertEngine';
import { forumAutoReply } from './forum-auto-reply';
import { loadRoster, OPERATOR_HANDLE, type MentionTarget, type Roster } from './forum-roster';
import { forumMentionRepository } from './forum-mention.repository';
import type { ForumAuthor } from './forum-author';
import { snippetOf } from './forum-index.service';
import type { ForumThreadDoc } from './forum-thread.model';
import type { ForumPostDoc } from './forum-post.model';

const log = createLogger('forum-mentions');

// Re-exported so the roster's long-standing import site keeps working; it now lives in
// `forum-roster.ts` (a leaf) because the prompt-side reader cannot import this module.
export { loadRoster, invalidateRoster, OPERATOR_HANDLE, type MentionTarget } from './forum-roster';

/**
 * Blank out fenced blocks and inline code, keeping the string's length so offsets still line up.
 *
 * A board about software pastes `@override`, `user@host` and shell one-liners constantly; every one
 * of those would otherwise page somebody at 3am.
 */
function maskCode(body: string): string {
  let out = body.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));
  out = out.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  return out;
}

/** A mention must start a word — `foo@bar` is an address, not an arrow. */
function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || /[\s([{<,;:"']/.test(ch);
}

/**
 * Every distinct handle addressed by a body, in the order they appear. Deduplicated: naming somebody
 * three times in one post is emphasis, not three requests.
 */
export function parseMentions(body: string, roster: Roster): MentionTarget[] {
  const masked = maskCode(body);
  const lower = masked.toLowerCase();
  const found: MentionTarget[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '@' || !isBoundary(masked[i - 1])) continue;
    // Longest name first, so an agent called `scout` can never shadow one called `scout runner`.
    for (const name of roster.names) {
      const end = i + 1 + name.length;
      if (lower.startsWith(name.toLowerCase(), i + 1) && !/[A-Za-z0-9_-]/.test(masked[end] ?? '')) {
        const target = roster.byName.get(name.toLowerCase());
        if (target && !seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          found.push(target);
        }
        i = end - 1;
        break;
      }
    }
  }
  return found;
}

export const forumMentionService = {
  /** The roster the composer's `@` autocomplete renders — agents in board order, operator first. */
  async roster(): Promise<MentionTarget[]> {
    const { byName } = await loadRoster(true);
    const all = [...byName.values()];
    return [
      ...all.filter((t) => t.kind === 'operator'),
      ...all.filter((t) => t.kind === 'agent').sort((a, b) => a.name.localeCompare(b.name)),
    ];
  },

  /**
   * Record every mention a new post makes (spec §11.1). Hangs off `forumService.addPost` — the one
   * funnel both the HTTP routes and the agent tool pass through — and is fire-and-forget for the
   * same reason indexing is: a mention that could fail somebody's post would cost more than the
   * feature is worth.
   *
   * Notification is not, by itself, a run. The operator's alert legs fire immediately; the agent
   * learns about it on its next turn through `forumRecall.mentions`, and answers when the operator
   * hits Run — or on its own, if fleet-wide auto-reply is on and the agent is in it (§11.6).
   */
  async record(input: { post: ForumPostDoc; thread: ForumThreadDoc; author: ForumAuthor }): Promise<void> {
    const roster = await loadRoster();
    const targets = parseMentions(input.post.body, roster).filter(
      // Naming yourself in your own post is prose, not paging yourself.
      (t) => !(t.kind === input.author.kind && (t.agentId ?? null) === (input.author.agent_id ?? null)),
    );
    if (!targets.length) return;

    const excerpt = snippetOf(input.post.body, 240);
    const rows = await forumMentionRepository.createMany(
      targets.map((t) => ({
        post_id: input.post._id,
        thread_id: input.thread._id,
        category_id: input.thread.category_id,
        thread_title: input.thread.title,
        excerpt,
        target: { kind: t.kind, agent_id: t.agentId, display_name: t.name },
        author: input.author,
        notified: t.notify,
      })),
    );

    for (const row of rows) {
      const target = targets.find((t) => t.name === row.target.display_name);
      eventBus.emit('forum:mention_created', {
        mentionId: String(row._id),
        threadId: String(input.thread._id),
        threadTitle: input.thread.title,
        postId: String(input.post._id),
        targetKind: row.target.kind,
        targetName: row.target.display_name,
        targetAgentId: row.target.agent_id,
        author: input.author.display_name,
        excerpt,
        notified: row.notified,
        createdAt: row.created_at.toISOString(),
      });

      if (!target?.notify) continue;
      // Both legs of the existing dual-alert pipeline: the durable inbox row (which grows a Run
      // action) and Telegram, so a mention reaches the operator wherever they are.
      void alertEngine
        .dispatch({
          agentId: row.target.kind === 'agent' ? row.target.agent_id : null,
          title:
            row.target.kind === 'operator'
              ? `${input.author.display_name} mentioned you on the forum`
              : `${input.author.display_name} mentioned ${row.target.display_name} on the forum`,
          content: `**${input.thread.title}**\n\n${excerpt}`,
          // Lets the inbox row grow a Run button — a mention is answerable from wherever it is read.
          kind: 'forum_mention',
          refId: String(row._id),
        })
        .catch((err) => log.warn({ err }, 'mention alert failed'));
    }

    log.info(
      { thread: String(input.thread._id), by: input.author.display_name, targets: targets.map((t) => t.name) },
      'forum mentions recorded',
    );

    // Auto-reply (§11.6). `rows` mirrors `targets`, which `parseMentions` returns in the order the
    // handles appear in the body — so "ask @architect, then @developer" is queued as written, and
    // each agent runs only once the one before it has posted. Fire-and-forget like the rest of this
    // method: the queue drains on its own clock, and a post must never fail because of it.
    void forumAutoReply
      .enqueue(
        rows
          .map((row, i) => ({
            mentionId: String(row._id),
            threadId: String(input.thread._id),
            threadTitle: input.thread.title,
            agentId: row.target.agent_id ?? null,
            agentName: row.target.display_name,
            isAgent: row.target.kind === 'agent' && targets[i]?.autoReply === true,
          }))
          .filter((r) => r.isAgent),
      )
      .catch((err) => log.warn({ err: String(err) }, 'auto-reply queueing failed'));
  },

  /** Operator triage: this one didn't need a turn. Reversible — reopening just flips it back. */
  async setStatus(id: string, status: 'pending' | 'dismissed'): Promise<boolean> {
    const updated = await forumMentionRepository.update(id, { status });
    return Boolean(updated);
  },
};
