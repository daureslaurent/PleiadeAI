import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import type { EventContext } from '../../core/event-bus/events.types';
import { sessionLock } from '../../core/session/SessionLock';
import { agentRunner, RunAbortedError } from '../../orchestrator/AgentRunner';
import { liveRuns } from '../../transport/ws/live-runs';
import { TurnRecorder } from '../../transport/ws/TurnRecorder';
import { agentRepository } from '../agents/agent.repository';
import { sessionRepository } from '../sessions/session.repository';
import { forumMentionRepository } from './forum-mention.repository';
import { forumThreadRepository } from './forum-thread.repository';
import { forumPostRepository } from './forum-post.repository';
import { forumService } from './forum.service';
import type { ForumMentionDoc } from './forum-mention.model';
import type { AutoReplyReason } from './forum-auto-reply';

const log = createLogger('forum-mention-run');

/** How long the run waits for a live operator chat on the same agent before giving up on the lock. */
const YIELD_TIMEOUT_MS = 60_000;

/**
 * Mentions whose run has been started and hasn't finished.
 *
 * A double-click on Run would otherwise spawn two sessions and post two replies to one question.
 * Tracked here rather than as a status on the row, because a *finished* run must stay re-runnable —
 * the usual reason to press Run twice is that the first attempt died on an unreachable endpoint.
 */
const inFlight = new Set<string>();

/** How much of the mentioning post is quoted into the brief before it is cut. */
const MAX_QUOTE_CHARS = 4_000;

export class MentionRunError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'MentionRunError';
  }
}

function quote(body: string): string {
  const text = body.length <= MAX_QUOTE_CHARS ? body : `${body.slice(0, MAX_QUOTE_CHARS)}\n…[truncated]`;
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * The seeded opening turn (spec §11.3).
 *
 * It has to carry four things or the agent answers the wrong question: who is asking, where, what
 * they actually said, and the fact that the reply is going back to the board — that last one changes
 * the register from "chat with the operator" to "post on a thread other agents will read".
 *
 * It also has to be explicit about *how* the reply lands. The brief used to promise the final text
 * would be posted automatically; agents replied with the `forum` tool anyway and then narrated what
 * they had just done, so every mention got answered twice — once with the real answer and once with
 * a summary of it. The tool is now the only intended route, and `drive` only posts for itself when
 * the agent posted nothing at all.
 *
 * And it has to say how an exchange *ends* (§11.7). There was no terminating move: every wake was
 * required to produce a post, every post opened with the name of whoever it answered, and — while a
 * bare `@name` still summoned — that name woke them straight back. Three agents spent twenty posts
 * and 107 minutes agreeing with each other about a design that had been settled in the first two.
 *
 * Removing that, though, removed the *useful* wake with it: told never to wake the asker back, an
 * agent finishing a job said "done" to a thread nobody was reading, and the project stopped
 * (`FORUM_AUTORUN_PLAN.md`). So the closing paragraphs now draw the line where it belongs —
 * acknowledging wakes nobody, handing the finished work back wakes exactly one person — and say how
 * to do the second in one call.
 */
function brief(mention: ForumMentionDoc, body: string, reason: AutoReplyReason | 'manual'): string {
  // A swept run was nobody's request. Told the same "you were asked, post your answer" brief as a
  // summons, an agent that has nothing to add writes an acknowledgement anyway — which is the board
  // full of pleasantries this whole mechanism exists to avoid. Say plainly which of the two happened.
  const opening =
    reason === 'sweep'
      ? `You were named on the agent forum by **${mention.author.display_name}**. Nobody asked you ` +
        'for a turn; the board is giving you one because this has been sitting unanswered and the ' +
        'work should not stop here.'
      : `You were mentioned on the agent forum by **${mention.author.display_name}**.`;
  return [
    opening,
    '',
    `Thread: **${mention.thread_title}** (\`${String(mention.thread_id)}\`)`,
    '',
    'The post that mentioned you:',
    '',
    quote(body),
    '',
    `Read the rest of the thread first if you need the context — \`forum\` with ` +
      `\`read_thread\` and thread_id \`${String(mention.thread_id)}\`.`,
    '',
    '**Post your answer yourself**, with the `forum` tool: `action: "reply"`, ' +
      `thread_id \`${String(mention.thread_id)}\`, reply_to \`${String(mention.post_id)}\`, and your ` +
      'answer as `body` (attach files there too if you produced any). That post *is* your reply — ' +
      'write it for the board: address what was asked, say what you verified versus what you ' +
      'suspect, skip the pleasantries.',
    '',
    'Reply **once**. After the tool returns, stop — do not repeat or summarise the post in your ' +
      'closing message, it is already on the thread.',
    '',
    `**You do not need to wake ${mention.author.display_name} back to acknowledge this.** Your ` +
      'reply lands on the thread they are watching, and the board gets them to it. Naming somebody ' +
      'in `wake` starts a whole new run for them, so use it when you genuinely need something ' +
      '*from* another agent to go further — and say in the post what you need.',
    '',
    `**The exception is handing the work back finished.** If it is done, reply with \`state: "done"\` ` +
      `and \`wake: ["${mention.author.display_name}"]\` in the *same* \`reply\` call — that is ` +
      'allowed here, and it is what makes the next step happen: whoever asked cannot act on your ' +
      'answer until something wakes them. If you are stuck instead, `state: "blocked"` and the same ' +
      'wake, saying what you are waiting on.',
    '',
    'If you have nothing to add beyond what the thread already says, say that in one line rather ' +
      'than restating the agreed conclusion — a post that repeats your own previous one is refused.',
  ].join('\n');
}

export const forumMentionRunner = {
  /**
   * Turn a pending mention into an ordinary conversation the operator can watch and continue.
   *
   * The operator's "yes, answer this" (spec §11.3). What this buys over a plain "notify" is the
   * closing half — the answer goes back to the thread, so the agent that asked sees it without the
   * operator acting as a courier.
   *
   * The same path serves fleet-wide auto-reply (§11.6), which presses this button by itself; every
   * safeguard here — the in-flight guard, the locked-thread skip, the `SessionLock` yield to a live
   * operator chat — therefore covers the automatic case unchanged.
   *
   * Returns the session id straight away; the turn itself runs detached, streaming to any Workspace
   * that subscribes. Waiting on it would make the route hang for the length of an inference call for
   * no benefit — the whole point is to *watch* the answer arrive.
   */
  async start(mentionId: string): Promise<{ sessionId: string; agentName: string }> {
    // The operator pressing Run starts a chain rather than continuing one — a human deciding this
    // deserves a turn is not a reply to anybody, which is the same reading §11.7 already gives a
    // cron job and an auto-mode tick. Without it, running a mention by hand to unstick a relay
    // handed the relay back whatever depth had stalled it.
    const { sessionId, agentName } = await this.begin(mentionId, { resetChain: true });
    return { sessionId, agentName };
  },

  /**
   * `start`, plus a handle on the turn itself.
   *
   * The HTTP route wants the session id the moment it exists and nothing else — waiting would make
   * it hang for the length of an inference call, and the whole point is to *watch* the answer
   * arrive. The auto-reply queue wants the opposite: it runs one mention at a time, in the order
   * they were written, and each agent must see the previous one's posted reply before it starts. So
   * `done` is offered rather than imposed — it settles when the reply has been posted back.
   *
   * `resetChain` says this run begins a summons chain instead of continuing the one it answers. The
   * operator's Run and the sweeper both pass it; the immediate auto-reply queue does not, because a
   * summons answered the moment it was written *is* the next link in that chain.
   */
  /** True while a run for this mention is under way — the sweeper's cheap pre-filter. */
  isInFlight(mentionId: string): boolean {
    return inFlight.has(mentionId);
  },

  async begin(
    mentionId: string,
    opts: { resetChain?: boolean; reason?: AutoReplyReason | 'manual' } = {},
  ): Promise<{ sessionId: string; agentName: string; done: Promise<void> }> {
    const mention = await forumMentionRepository.findById(mentionId);
    if (!mention) throw new MentionRunError('no such mention', 404);
    if (mention.target.kind !== 'agent' || !mention.target.agent_id) {
      throw new MentionRunError('this mention addresses the operator — answer it on the thread', 400);
    }
    if (mention.status === 'answered') throw new MentionRunError('this mention was already answered', 409);
    // A second Run while the first turn is still going would spawn a second session and post two
    // replies to the same question. A *finished* run stays re-runnable on purpose: the common reason
    // to press Run twice is that the first attempt died on an unreachable endpoint.
    if (inFlight.has(String(mention._id))) {
      throw new MentionRunError('a run for this mention is already under way', 409);
    }

    const agent = await agentRepository.findById(mention.target.agent_id);
    if (!agent) throw new MentionRunError('the mentioned agent no longer exists', 404);

    const post = await forumPostRepository.findById(String(mention.post_id));
    if (!post || post.deleted) throw new MentionRunError('the post that mentioned it is gone', 404);

    const session = await sessionRepository.create({
      agentId: agent._id,
      agentName: agent.name,
      title: `@ ${mention.thread_title}`,
      origin: 'forum',
      forumThreadId: mention.thread_id,
      forumMentionId: mention._id,
      forumChainReset: opts.resetChain === true,
    });
    const sessionId = String(session._id);

    await forumMentionRepository.update(mention._id, { session_id: session._id });
    inFlight.add(String(mention._id));

    eventBus.emit('conversation:session_created', {
      sessionId,
      agentId: String(agent._id),
      agentName: agent.name,
      title: session.title,
      origin: 'forum',
    });

    const reason = opts.reason ?? 'manual';
    // The board's own "this just started moving", so the Forum page can show a pending mention
    // becoming a live run without refetching. `conversation:session_created` says a session appeared;
    // only this says which mention it answers and whether anybody asked for it.
    eventBus.emit('forum:mention_run', {
      mentionId: String(mention._id),
      threadId: String(mention.thread_id),
      sessionId,
      agentName: agent.name,
      authorName: mention.author.display_name,
      reason,
    });

    const done = this.drive(mention, post.body, sessionId, agent.name, String(agent._id), reason)
      .catch((err) => log.error({ err: String(err), mentionId }, 'mention run failed'))
      .finally(() => inFlight.delete(String(mention._id)));

    return { sessionId, agentName: agent.name, done };
  },

  /**
   * The run itself. Mirrors the socket layer's "the client left mid-turn" path — a `TurnRecorder`
   * off the EventBus, persisted server-side — because nobody is guaranteed to be watching this
   * session at all, and a turn whose tool calls were only ever in a browser buffer is a turn lost.
   */
  async drive(
    mention: ForumMentionDoc,
    postBody: string,
    sessionId: string,
    agentName: string,
    agentId: string,
    reason: AutoReplyReason | 'manual' = 'manual',
  ): Promise<void> {
    const ctx: EventContext = { sessionId, agentId, agentName, depth: 0 };
    const text = brief(mention, postBody, reason);
    // Anything this agent posts on the thread from here on is its reply. Taken before the first
    // message rather than after the run, so a tool call that lands early still counts.
    const runStartedAt = new Date();

    await sessionRepository.addMessage(sessionId, { role: 'user', text });
    eventBus.emit('chat:user_message', { ctx, content: text });

    // Registered before the wait below, so a Workspace opening this session while it queues is told
    // the run is live rather than showing an idle conversation that suddenly sprouts an answer.
    const recorder = new TurnRecorder(sessionId, agentName);
    recorder.start();
    // The controller is what makes the Workspace's stop button work on a mention run: `chat:stop`
    // looks the session up in `liveRuns` and fires it. Registered without one, the turn ran to
    // completion no matter how hard the operator pressed stop.
    const controller = new AbortController();
    liveRuns.start(sessionId, recorder, controller);

    // A live operator chat on this agent wins; the mention has already waited, it can wait a minute.
    await sessionLock.waitUntilFree(agentId, YIELD_TIMEOUT_MS);

    let answer = '';
    let failure = '';
    let stopped = false;
    try {
      const result = await agentRunner.run({
        agentName,
        sessionId,
        depth: 0,
        userText: text,
        signal: controller.signal,
      });
      answer = result.text;
      const turn = recorder.build(answer);
      await sessionRepository.addMessage(sessionId, {
        role: 'assistant',
        text: answer,
        blocks: turn.blocks,
        reasoning: turn.reasoning || undefined,
        trace: turn.trace,
        memories: turn.memories,
        context_tokens: turn.contextTokens,
        context_window: turn.contextWindow,
        turn_id: result.turnId,
        run_id: result.runId,
      });
      eventBus.emit('conversation:turn_complete', {
        ctx,
        answer,
        blocks: turn.blocks,
        memories: turn.memories,
        turnId: result.turnId,
        runId: result.runId,
      });
    } catch (err) {
      // Operator hit stop: keep whatever streamed so far, but no error banner — this is a clean end,
      // and the mention stays pending so it can simply be run again.
      stopped = err instanceof RunAbortedError || controller.signal.aborted;
      failure = err instanceof Error ? err.message : String(err);
      const turn = recorder.build('');
      const blocks = stopped
        ? turn.blocks
        : [...turn.blocks, { kind: 'text' as const, text: `\n\n⚠️ The run failed: ${failure}` }];
      await sessionRepository
        .addMessage(sessionId, { role: 'assistant', text: '', blocks, trace: turn.trace })
        .catch((e) => log.error({ err: String(e) }, 'failed to persist interrupted mention turn'));
      eventBus.emit('conversation:turn_complete', { ctx, answer: '', blocks, turnId: '', runId: '' });
      if (stopped) log.info({ mentionId: String(mention._id), sessionId }, 'mention run stopped by user');
    } finally {
      recorder.stop();
      liveRuns.end(sessionId);
    }

    // Did the agent answer for itself? The brief tells it to, and a post it wrote through the `forum`
    // tool is a better reply than its closing narration in every case: it chose the wording, it could
    // attach files, and it may have posted several. Posting the final text *as well* is what used to
    // put two replies on every mention. So the auto post-back below is now strictly the fallback for
    // a turn that posted nothing — a mention must never end up silently unanswered.
    const own = await forumPostRepository
      .latestByAgentSince(String(mention.thread_id), agentId, runStartedAt)
      .catch((err) => {
        log.error({ err: String(err), mentionId: String(mention._id) }, 'could not check for the agent’s own reply');
        return null;
      });
    if (own) {
      await forumMentionRepository.update(mention._id, {
        status: 'answered',
        answered_at: new Date(),
        reply_post_id: own._id,
      });
      log.info(
        { mentionId: String(mention._id), post: String(own._id), agent: agentName },
        'mention answered by the agent’s own forum post',
      );
      return;
    }

    if (failure || !answer.trim()) {
      log.warn({ mentionId: String(mention._id), failure }, 'mention run produced nothing to post');
      return;
    }

    // Nothing was posted during the turn: fall back to the final text, so the agent that asked still
    // gets an answer on the thread. Skipped rather than forced when the thread has since been locked
    // — moderation closed it on purpose, and the answer still lives in the session.
    try {
      const thread = await forumThreadRepository.findById(String(mention.thread_id));
      if (!thread || thread.status !== 'open') {
        log.info({ mentionId: String(mention._id) }, 'thread no longer open — answer not posted back');
        await forumMentionRepository.update(mention._id, { status: 'answered', answered_at: new Date() });
        return;
      }
      const reply = await forumService.addPost({
        thread,
        body: answer,
        author: { kind: 'agent', agent_id: agentId, display_name: agentName },
        replyTo: String(mention.post_id),
        // The fallback is a closing message the agent wrote for the operator, not a post it composed
        // for the board — it never opted into waking anybody, so an `@name` in its prose must not be
        // read as one. `planSummons` would decide the same way with the default settings; saying it
        // here means the fallback stays inert even for a fleet that has opted bare mentions back in.
        summons: { mentions: [], chainDepth: 0 },
      });
      await forumMentionRepository.update(mention._id, {
        status: 'answered',
        answered_at: new Date(),
        reply_post_id: reply._id,
      });
      log.info(
        { mentionId: String(mention._id), thread: String(thread._id), agent: agentName },
        'mention answered by fallback post-back — the agent did not reply with the forum tool',
      );
    } catch (err) {
      log.error({ err: String(err), mentionId: String(mention._id) }, 'could not post the answer back');
    }
  },
};
