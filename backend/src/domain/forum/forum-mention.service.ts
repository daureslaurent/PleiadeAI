import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import { alertEngine } from '../../alerts/AlertEngine';
import { agentRepository } from '../agents/agent.repository';
import { forumMentionRepository } from './forum-mention.repository';
import type { ForumAuthor } from './forum-author';
import { snippetOf } from './forum-index.service';
import type { ForumThreadDoc } from './forum-thread.model';
import type { ForumPostDoc } from './forum-post.model';

const log = createLogger('forum-mentions');

/** The operator's handle on the board. Matches `OPERATOR_AUTHOR.display_name`, case-insensitively. */
export const OPERATOR_HANDLE = 'Operator';

/** How long the agent roster is reused before being re-read. Mentions are written on a hot path. */
const ROSTER_TTL_MS = 30_000;

export interface MentionTarget {
  kind: 'agent' | 'operator';
  agentId: string | null;
  name: string;
  /** False when the agent has `forum_mentions` off — the row is written, nothing is dispatched. */
  notify: boolean;
}

interface Roster {
  /** Lower-cased name → target, so resolution is case-insensitive but the stored name is canonical. */
  byName: Map<string, MentionTarget>;
  /** Names longest-first: `@image smith` must win over an agent literally called `image`. */
  names: string[];
  at: number;
}

let cached: Roster | null = null;

/**
 * Resolution runs against the live agent roster, not a `@\w+` pattern.
 *
 * Agent names are operator-chosen and may contain spaces or punctuation, so a pattern would both
 * miss `@image smith` and invent mentions out of `user@host`. Matching known names instead means an
 * unknown `@foo` is simply prose — there is no such thing on this board as a mention that goes
 * nowhere to be delivered.
 */
export async function loadRoster(force = false): Promise<Roster> {
  if (!force && cached && Date.now() - cached.at < ROSTER_TTL_MS) return cached;
  const agents = await agentRepository.list();
  const byName = new Map<string, MentionTarget>([
    [OPERATOR_HANDLE.toLowerCase(), { kind: 'operator', agentId: null, name: OPERATOR_HANDLE, notify: true }],
  ]);
  for (const agent of agents) {
    byName.set(agent.name.toLowerCase(), {
      kind: 'agent',
      agentId: String(agent._id),
      name: agent.name,
      notify: agent.forum_mentions !== false,
    });
  }
  cached = {
    byName,
    names: [...byName.values()].map((t) => t.name).sort((a, b) => b.length - a.length),
    at: Date.now(),
  };
  return cached;
}

/** Drop the roster cache — called when an agent is created, renamed or deleted. */
export function invalidateRoster(): void {
  cached = null;
}

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
   * Notification is deliberately *not* a run. The operator's alert legs fire immediately; the agent
   * learns about it on its next turn through `forumRecall.mentions`, and answers only when the
   * operator hits Run.
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
  },

  /** Operator triage: this one didn't need a turn. Reversible — reopening just flips it back. */
  async setStatus(id: string, status: 'pending' | 'dismissed'): Promise<boolean> {
    const updated = await forumMentionRepository.update(id, { status });
    return Boolean(updated);
  },
};
