import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import { alertEngine } from '../../alerts/AlertEngine';
import { settingsService } from '../settings/settings.service';
import { sessionRepository } from '../sessions/session.repository';
import { forumAutoReply } from './forum-auto-reply';
import { loadRoster, type MentionTarget, type Roster } from './forum-roster';
import { forumMentionRepository } from './forum-mention.repository';
import type { ForumSummonBlock } from './forum-mention.model';
import type { ForumAuthor } from './forum-author';
import { snippetOf } from './forum-index.service';
import type { ForumThreadDoc, ForumWorkState } from './forum-thread.model';
import type { ForumPostDoc } from './forum-post.model';

const log = createLogger('forum-mentions');

// Re-exported so the roster's long-standing import site keeps working; it now lives in
// `forum-roster.ts` (a leaf) because the prompt-side reader cannot import this module.
export { loadRoster, invalidateRoster, OPERATOR_HANDLE, type MentionTarget } from './forum-roster';

/**
 * The prefix that turns an address into a summons: `@run:developer`.
 *
 * Deliberately not something a model produces by reflex. The whole failure this exists to stop is
 * that `@name` at the head of a reply is the *addressee marker* every forum and mail convention
 * teaches, so a model writing "@project_manager acknowledged" is being polite, not filing a request
 * — and there was no way for the parser to tell. `run:` has to be typed on purpose.
 */
const SUMMON_PREFIX = 'run:';

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

/** One handle found in a body, and whether it was written as a summons or as an address. */
export interface ParsedMention {
  target: MentionTarget;
  /** True when it was written `@run:name` — an explicit request for a turn. */
  explicit: boolean;
}

/**
 * Every distinct handle addressed by a body, in the order they appear. Deduplicated: naming somebody
 * three times in one post is emphasis, not three requests. If any one of those occurrences was
 * written `@run:name`, the whole mention counts as explicit — asking once is asking.
 */
export function parseMentions(body: string, roster: Roster): ParsedMention[] {
  const masked = maskCode(body);
  const lower = masked.toLowerCase();
  const found: ParsedMention[] = [];
  const byName = new Map<string, ParsedMention>();

  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '@' || !isBoundary(masked[i - 1])) continue;
    // `@run:` may sit between the `@` and the name; everything after it resolves exactly as before.
    const explicit = lower.startsWith(SUMMON_PREFIX, i + 1);
    const nameStart = i + 1 + (explicit ? SUMMON_PREFIX.length : 0);
    // Longest name first, so an agent called `scout` can never shadow one called `scout runner`.
    for (const name of roster.names) {
      const end = nameStart + name.length;
      if (lower.startsWith(name.toLowerCase(), nameStart) && !/[A-Za-z0-9_-]/.test(masked[end] ?? '')) {
        const target = roster.byName.get(name.toLowerCase());
        if (target) {
          const seen = byName.get(name.toLowerCase());
          if (seen) seen.explicit ||= explicit;
          else {
            const parsed: ParsedMention = { target, explicit };
            byName.set(name.toLowerCase(), parsed);
            found.push(parsed);
          }
        }
        i = end - 1;
        break;
      }
    }
  }
  return found;
}

/**
 * Where the post being written sits in a chain of summonses.
 *
 * `AgentRunner` already carries a hop depth for `ask_agent`, and `HopGuard` already refuses to go
 * deeper than the operator allows. A forum summons is the same shape spread over minutes rather than
 * milliseconds — B answers A, and its answer wakes C — so it needs the same ceiling, and the depth
 * has to travel with it. It travels through the session: a run started by a mention records
 * `forum_mention_id`, so any post that run writes can look up what woke it.
 */
export interface SummonContext {
  /** The mention this run is answering, if it was started by one. */
  mentionId: string | null;
  /** Who wrote that mention — the one agent this post may not summon straight back. */
  wokenBy: ForumAuthor | null;
  /** The thread that mention was on. A back-summon elsewhere is a genuine hand-off, not a bounce. */
  threadId: string | null;
  /** Depth of the mention that woke us. Anything this post summons sits at `depth + 1`. */
  depth: number;
}

const ROOT_CONTEXT: SummonContext = { mentionId: null, wokenBy: null, threadId: null, depth: 0 };

/**
 * Recover the chain context for a run, from its session.
 *
 * Returns the root context for everything else — an operator chat, a cron job, an auto-mode loop.
 * That is the right answer rather than a fallback: none of those is a reply to anybody, so a summons
 * written in one legitimately starts a fresh chain.
 */
export async function summonContextFor(sessionId: string): Promise<SummonContext> {
  if (!sessionId) return ROOT_CONTEXT;
  try {
    const session = await sessionRepository.findById(sessionId);
    if (!session?.forum_mention_id) return ROOT_CONTEXT;
    const mention = await forumMentionRepository.findById(String(session.forum_mention_id));
    if (!mention) return ROOT_CONTEXT;
    return {
      mentionId: String(mention._id),
      wokenBy: mention.author,
      threadId: String(mention.thread_id),
      // A run the operator or the sweeper started answers this mention without continuing its chain
      // — neither is a reply to anybody, the same reading a cron job and an auto-mode tick already
      // get. `wokenBy` and `threadId` deliberately stay: starting a fresh chain must not also switch
      // off the back-summon guard, which is about *who* is being bounced, not how deep.
      depth: session.forum_chain_reset ? 0 : (mention.chain_depth ?? 0),
    };
  } catch (err) {
    // A depth we cannot read is treated as a root, which is the permissive answer — but the pair
    // guard and the per-thread budget still stand behind it, so nothing runs unbounded.
    log.warn({ err: String(err), sessionId }, 'summon context unavailable — treating as a chain root');
    return ROOT_CONTEXT;
  }
}

/** One decided mention: who, whether it summons, and which guard withheld it if one did. */
export interface PlannedMention {
  target: MentionTarget;
  summon: boolean;
  blocked: ForumSummonBlock | null;
}

export interface SummonPlan {
  mentions: PlannedMention[];
  /** The depth every summons in this plan is recorded at. */
  chainDepth: number;
}

/** An empty plan — nothing addressed, nothing woken. */
const EMPTY_PLAN: SummonPlan = { mentions: [], chainDepth: 0 };

/** Two board identities are the same person when kind and agent id agree. */
function isSame(a: ForumAuthor | null | undefined, b: ForumAuthor | null | undefined): boolean {
  if (!a || !b) return false;
  return a.kind === b.kind && (a.agent_id ?? null) === (b.agent_id ?? null);
}

/** A roster entry as a board identity, so targets and authors compare on the same shape. */
function asAuthor(t: MentionTarget): ForumAuthor {
  return { kind: t.kind, agent_id: t.agentId, display_name: t.name };
}

/**
 * Decide, for one post, who is merely addressed and who is actually being asked to take a turn.
 *
 * The single decision point for §11.7, called from two places on purpose: the `forum` tool calls it
 * *before* posting so it can tell the agent in its tool result exactly who it woke and who it did
 * not (a fan-out of three names is three inference runs, and that cost was previously invisible to
 * the one deciding to spend it), and `record` calls it for every other write path — the operator's
 * composer, the moderator, the mention runner's fallback post.
 *
 * Three ways to summon, and nothing else:
 *
 * - `wake: ["name"]` on the tool call. The strongest, because a model cannot fill a structured
 *   argument by reflex the way it opens a reply with a name.
 * - `@run:name` in the body, for the operator's plain textarea and for a model that inlines it.
 * - a bare `@name` **written by the operator**, or by an agent when the fleet has opted back in.
 *   A human typing a name means it; the loop this guards against is agent-to-agent.
 */
export async function planSummons(input: {
  body: string;
  author: ForumAuthor;
  /** Names from the tool's `wake` argument. Resolved against the roster like any other handle. */
  wake?: string[];
  context?: SummonContext;
  /** The thread being posted to — needed to tell a back-summon from an ordinary hand-off. */
  threadId?: string | null;
  /**
   * The work state this post sets, when it sets one. `done` or `blocked` makes the post a hand-back,
   * which is the one case allowed to summon back the agent that woke you.
   */
  state?: ForumWorkState | 'none' | null;
  /** How many files this post carries. Delivering something is also handing work back. */
  attachmentCount?: number;
}): Promise<SummonPlan> {
  const roster = await loadRoster();
  const settings = await settingsService.get();
  const ctx = input.context ?? ROOT_CONTEXT;
  const chainDepth = ctx.mentionId ? ctx.depth + 1 : 0;

  const parsed = parseMentions(input.body, roster).filter(
    // Naming yourself in your own post is prose, not paging yourself.
    (p) => !isSame(asAuthor(p.target), input.author),
  );

  // `wake` may name somebody the body never mentions — asking for a turn without writing the handle
  // into the prose is legitimate, and the row still has to exist for the target to see it.
  const woken = new Set<string>();
  for (const raw of input.wake ?? []) {
    const name = String(raw).replace(/^@/, '').replace(new RegExp(`^${SUMMON_PREFIX}`, 'i'), '').trim();
    const target = roster.byName.get(name.toLowerCase());
    if (!target || isSame(asAuthor(target), input.author)) continue;
    woken.add(target.name.toLowerCase());
    if (!parsed.some((p) => p.target.name.toLowerCase() === target.name.toLowerCase())) {
      parsed.push({ target, explicit: true });
    }
  }

  const bareSummons = input.author.kind === 'operator' || settings.forum_bare_mention_summons === true;
  const maxChain = Math.max(1, settings.forum_mention_max_chain ?? 4);

  /**
   * Is this post handing finished work back, rather than acknowledging?
   *
   * The distinction the back-summon guard could not previously make. Both look like "a reply to the
   * agent that woke me", but one of them is the moment the asker has to run again — it commissioned
   * this work and cannot act on it until something wakes it — and the other is the salutation that
   * ate a thread. A state transition and an attachment are the two things a courtesy reply does not
   * have, and both are structured: an agent cannot produce either by reflex.
   */
  const handBack =
    input.state === 'done' || input.state === 'blocked' || (input.attachmentCount ?? 0) > 0;

  const mentions: PlannedMention[] = parsed.map(({ target, explicit }) => {
    // The operator is addressable but never runnable — @Operator is a question for a person.
    // An agent excluded from auto-reply is *not* handled here: it was still genuinely asked, and
    // saying otherwise would show the operator "mentioned" on a row that is actually waiting on
    // them. Its exclusion is applied where it belongs, at the point of queueing.
    if (target.kind !== 'agent') return { target, summon: false, blocked: null };

    const asked = explicit || woken.has(target.name.toLowerCase()) || bareSummons;
    if (!asked) return { target, summon: false, blocked: null };

    // The back-summon. B is running because A woke it; B's reply already reaches A, on the very
    // thread A is watching. Waking A *again* from that reply is the two-post cycle that ate a whole
    // thread's budget on prod. Only on the same thread: summoning A on a different thread is a
    // genuine hand-off, not a bounce.
    //
    // Unless B is handing the finished work back, which is the case this guard was refusing on the
    // live board: A commissioned the work and will not run again on its own, so "done" said only to
    // a thread is done nobody acts on. The old answer — go and post it on some other thread — asked
    // a model to route around a rule it could not see; delivering it where it was asked for and
    // waking the asker is what everybody was trying to do anyway. The pair cap remains the leash.
    if (
      ctx.mentionId &&
      isSame(ctx.wokenBy, asAuthor(target)) &&
      input.threadId &&
      ctx.threadId === String(input.threadId) &&
      !handBack
    ) {
      return { target, summon: true, blocked: 'back_summon' };
    }

    if (chainDepth > maxChain) return { target, summon: true, blocked: 'chain_depth' };
    return { target, summon: true, blocked: null };
  });

  return { mentions, chainDepth };
}

/** Why a summons was withheld, in words the agent that wrote it can act on. */
export function blockReason(block: ForumSummonBlock, name: string): string {
  switch (block) {
    case 'back_summon':
      return `you are answering @${name} — your reply already reaches them on this thread, and they will read it when they next run. If you are handing them finished work rather than acknowledging, say so: reply with \`state\` set to "done" (or "blocked", if you are stuck), or attach what you produced, and they are woken to pick it up.`;
    case 'chain_depth':
      return `this exchange is already several hand-offs deep with no human in it. @${name} was told, but will answer when the operator runs it.`;
    case 'pair_rate':
      return `you have already summoned @${name} on this thread recently. Say what is still missing and let them pick it up, or take it to a new thread.`;
    case 'budget':
      return `this thread has spent its automatic replies. @${name} was told, but will answer when the operator runs it.`;
    default:
      return `@${name} was told but not woken.`;
  }
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
   * Record every mention a new post makes (spec §11.1, §11.7). Hangs off `forumService.addPost` —
   * the one funnel both the HTTP routes and the agent tool pass through — and is fire-and-forget for
   * the same reason indexing is: a mention that could fail somebody's post would cost more than the
   * feature is worth.
   *
   * Notification is not, by itself, a run — and now neither is being named. A bare `@name` from an
   * agent records the row, raises the alert legs, and rides into the target's next turn as a
   * pointer. Only a *summons* (`@run:name`, the tool's `wake` argument, or the operator writing a
   * name) reaches the auto-reply queue, and only if the chain and back-summon guards let it.
   */
  async record(input: {
    post: ForumPostDoc;
    thread: ForumThreadDoc;
    author: ForumAuthor;
    /** The plan the `forum` tool already computed and reported, so both sides agree exactly. */
    plan?: SummonPlan;
  }): Promise<void> {
    const plan =
      input.plan ??
      (await planSummons({
        body: input.post.body,
        author: input.author,
        threadId: String(input.thread._id),
      }).catch((err) => {
        log.warn({ err: String(err) }, 'summon plan failed — post recorded with no mentions');
        return EMPTY_PLAN;
      }));
    if (!plan.mentions.length) return;

    const excerpt = snippetOf(input.post.body, 240);
    const rows = await forumMentionRepository.createMany(
      plan.mentions.map((m) => ({
        post_id: input.post._id,
        thread_id: input.thread._id,
        category_id: input.thread.category_id,
        thread_title: input.thread.title,
        excerpt,
        target: { kind: m.target.kind, agent_id: m.target.agentId, display_name: m.target.name },
        author: input.author,
        notified: m.target.notify,
        summon: m.summon,
        run_blocked: m.blocked,
        chain_depth: plan.chainDepth,
      })),
    );

    rows.forEach((row, i) => {
      const planned = plan.mentions[i];
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
        summon: row.summon,
        createdAt: row.created_at.toISOString(),
      });

      if (!planned?.target.notify) return;
      // Both legs of the existing dual-alert pipeline: the durable inbox row (which grows a Run
      // action) and Telegram, so a mention reaches the operator wherever they are. The title says
      // which of the two things happened — being told and being asked are not the same event, and
      // an inbox that renders them identically is one the operator stops reading.
      const verb = row.summon ? 'asked' : 'mentioned';
      void alertEngine
        .dispatch({
          agentId: row.target.kind === 'agent' ? row.target.agent_id : null,
          title:
            row.target.kind === 'operator'
              ? `${input.author.display_name} mentioned you on the forum`
              : `${input.author.display_name} ${verb} ${row.target.display_name} on the forum`,
          content: `**${input.thread.title}**\n\n${excerpt}`,
          // Lets the inbox row grow a Run button — a mention is answerable from wherever it is read.
          kind: 'forum_mention',
          refId: String(row._id),
        })
        .catch((err) => log.warn({ err }, 'mention alert failed'));
    });

    log.info(
      {
        thread: String(input.thread._id),
        by: input.author.display_name,
        depth: plan.chainDepth,
        summoned: plan.mentions.filter((m) => m.summon && !m.blocked).map((m) => m.target.name),
        addressed: plan.mentions.filter((m) => !m.summon).map((m) => m.target.name),
        withheld: plan.mentions.filter((m) => m.blocked).map((m) => `${m.target.name}:${m.blocked}`),
      },
      'forum mentions recorded',
    );

    // Auto-reply (§11.6). `rows` mirrors `plan.mentions`, which `parseMentions` returns in the order
    // the handles appear in the body — so "ask @run:architect, then @run:developer" is queued as
    // written, and each agent runs only once the one before it has posted. Fire-and-forget like the
    // rest of this method: the queue drains on its own clock, and a post must never fail because of
    // it. Blocked summonses are deliberately not queued: they stay `pending`, which is exactly the
    // state the operator's Run button expects.
    void forumAutoReply
      .enqueue(
        rows
          .map((row, i) => ({
            mentionId: String(row._id),
            threadId: String(input.thread._id),
            threadTitle: input.thread.title,
            agentId: row.target.agent_id ?? null,
            agentName: row.target.display_name,
            authorName: input.author.display_name,
            // A summons no guard withheld, addressed to an agent that has not opted out of running
            // itself. The opt-out lives here rather than in the plan because it changes who *runs*,
            // not what was *asked* — the row stays a summons and the operator's Run button honours it.
            eligible:
              Boolean(plan.mentions[i]?.summon) &&
              !plan.mentions[i]?.blocked &&
              plan.mentions[i]?.target.autoReply === true,
          }))
          .filter((r) => r.eligible),
      )
      .catch((err) => log.warn({ err: String(err) }, 'auto-reply queueing failed'));
  },

  /** Operator triage: this one didn't need a turn. Reversible — reopening just flips it back. */
  async setStatus(id: string, status: 'pending' | 'dismissed'): Promise<boolean> {
    const updated = await forumMentionRepository.update(id, { status });
    return Boolean(updated);
  },
};
