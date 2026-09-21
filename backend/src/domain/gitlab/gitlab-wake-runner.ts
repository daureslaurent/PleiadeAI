import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import type { EventContext } from '../../core/event-bus/events.types';
import { sessionLock } from '../../core/session/SessionLock';
import { agentRunner } from '../../orchestrator/AgentRunner';
import { liveRuns } from '../../transport/ws/live-runs';
import { TurnRecorder } from '../../transport/ws/TurnRecorder';
import { notificationRepository } from '../notifications/notification.repository';
import { runQueue } from '../run-queue/run-queue.service';
import type { RunQueueDoc } from '../run-queue/run-queue.model';
import { sessionRepository } from '../sessions/session.repository';
import type { WakeFamily } from './gitlab-poll.catalogue';
import type { WakeDecision } from './gitlab-webhook.service';

const log = createLogger('gitlab-wake');

/** How long a woken run waits for a live operator chat on the same agent before giving up. */
const YIELD_TIMEOUT_MS = 60_000;

/** How much of the triggering text is quoted into the brief before it is cut. */
const MAX_QUOTE_CHARS = 4_000;

/**
 * GitLab wakes (`GITLAB_PLAN.md` §5, `RUN_QUEUE_PLAN.md`).
 *
 * The ordering used to live here, in an in-memory array drained one at a time. It now lives in the
 * fleet's **run queue**, and the reason is the half of the problem the local array could not see:
 * it serialised GitLab against GitLab, while the forum's identical array serialised the forum
 * against the forum, and neither knew the other was holding the one inference server. This module
 * keeps what is GitLab's — which agent, what brief, what finishing move — and registers a handler
 * the lane calls when a row's turn comes.
 *
 * Serial is still the point, and for the same reason it always was: two agents woken by the same
 * thread have to see each other's posted comments, which only exist once the first run has
 * finished.
 *
 * What changed for the worse in nothing, and for the better in two places: a queued wake now
 * survives a restart (the row carries the whole decision), and the operator can cancel one before
 * it is paid for.
 */
export interface Queued extends WakeDecision {
  deliveryId: string;
  agentId: string;
  agentName: string;
}

/**
 * What a `gitlab` row carries. Two shapes, because two things start a GitLab turn: an event that
 * woke somebody, and the operator pressing **Check now** on a project.
 */
type GitLabRunPayload =
  | ({ mode: 'wake' } & Queued)
  | { mode: 'turn'; title: string; brief: string; notify: string; readOnly?: boolean };

/**
 * Deliveries already handled, in memory, for the *synchronous* answer the webhook route and the
 * poll tick need before they decide whether to spend a row. The durable half of the same question
 * is `dedupe_key` on the queue, which is what survives a restart.
 */
const seen = new Set<string>();

function quote(body: string): string {
  const text = body.length <= MAX_QUOTE_CHARS ? body : `${body.slice(0, MAX_QUOTE_CHARS)}\n…[truncated]`;
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * The seeded opening turn.
 *
 * It carries the four things the forum's brief taught us a woken agent needs or it answers the wrong
 * question: who directed this at them, where it lives, what was actually said, and — the one that
 * changes the register entirely — that the reply goes back to GitLab where humans will read it,
 * not into a chat with the operator.
 *
 * It also names the finishing move. A woken agent that investigates well and then says nothing on
 * the issue has done nothing, as far as everyone waiting on it is concerned.
 *
 * The opening sentence arrives on the decision (`lead`) rather than being switched on here: the
 * poller has fourteen kinds to announce (`GITLAB_PLAN.md` §13) and each knows its own wording, while
 * what the agent must *do* about it collapses into the four families below.
 */
const FINISH: Record<WakeFamily, string> = {
  merge_request:
    '**Finish by reviewing on the merge request itself** — `gitlab_mr({action:"comment"})`, with ' +
    '`path` and `line` when your point is about a specific line. Read the whole `diff` first. If ' +
    'it is good, say so and `approve`; if it is not, say exactly what would have to change.',
  issue:
    '**Finish by commenting on the issue** — `gitlab_issue({action:"comment"})` — with what you ' +
    'found, what you did, and what you need from a human if you are blocked. Close it only when ' +
    'the work is genuinely done, and say in the closing comment how it was verified.',
  note:
    '**Finish by replying where you were named** — `gitlab_issue({action:"comment"})` or ' +
    '`gitlab_mr({action:"comment"})`. Answer the question that was actually asked; if it was not ' +
    'addressed to you in any useful sense, say nothing and stop.',
  pipeline:
    '**Read the failing job log before you conclude anything** — `gitlab_ci({action:"job_log"})`; ' +
    'a runner timeout and a broken test look identical from the pipeline list. Then either fix it ' +
    'on a branch and open a merge request, or open an issue saying what is broken and why. ' +
    'Retrying an unchanged failing build is the one move that is always wrong.',
  build:
    '**This is your own merge request, so fix it — do not review it.** Read the log of a failing ' +
    'job named above first (`gitlab_ci({action:"job_log", job_id: <id>})`): the reason is usually ' +
    'in the last twenty lines, and a runner timeout and a broken build look identical from ' +
    'anywhere else. Then correct it **on the same source branch** — `gitlab_repo({action:"clone"})` ' +
    'when you need to run something to be sure, `gitlab_commit` for a fix you are certain of — and ' +
    'push. GitLab re-runs the pipeline by itself; you do not need to retry anything, and retrying ' +
    'an unchanged build is the one move that is always wrong. If the failure is the CI config ' +
    'itself, validate the correction with `gitlab_ci({action:"lint"})` before committing it. Say ' +
    'on the merge request what was broken and what you changed, so the next red build is not ' +
    'debugged from scratch.',
  conflict:
    '**Your merge request no longer merges cleanly.** Find out against what: `gitlab_mr({action:' +
    '"get"})` gives the merge status, and the target branch has moved since you branched. Rebase ' +
    'the source branch onto it — `gitlab_mr({action:"rebase"})` when there is nothing to resolve, ' +
    'otherwise clone (`gitlab_repo`), rebase there, resolve the conflicts properly and push. Do ' +
    'not resolve a conflict by discarding the other side because it is in your way; read what ' +
    'changed on the target first. If the conflict means the work has been overtaken, say so on the ' +
    'merge request and close it rather than forcing it through.',
};

function brief(item: Queued): string {
  // What introduces the quoted block. For most families it is the item's own text ("the issue
  // says"); for a broken build or a conflict the body is state we *fetched* rather than something
  // anybody wrote, and calling that "what the build says" reads as a quotation of the log.
  const intro =
    item.family === 'build' || item.family === 'conflict' || item.family === 'pipeline'
      ? 'What GitLab reports right now:'
      : item.family === 'merge_request'
        ? 'The merge request says:'
        : item.family === 'note'
          ? 'It says:'
          : 'The issue says:';

  return [
    item.lead,
    '',
    ...(item.body ? [intro, '', quote(item.body), ''] : []),
    item.url ? `It is at ${item.url}.` : '',
    '',
    'Work it with the `gitlab_*` tools, and **start by reading the item itself** — ' +
      '`gitlab_issue({action:"get"})` or `gitlab_mr({action:"get"})` returns the whole thread, not ' +
      'just the description quoted above. Writing to an item you have not read this turn is ' +
      'refused, and the reason is this exact situation: what you were told about it is a snapshot, ' +
      'and somebody may have answered, closed it or changed their mind since.',
    '',
    FINISH[item.family],
    '',
    'Your answer here is not delivered anywhere by itself: the tool call is what other people see. ' +
      'If there is nothing useful to add, say so in one line rather than restating what the thread ' +
      'already says.',
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
}

/** Where a wake came from, for the operator's queue list. Set by the caller that enqueued it. */
export type WakeOrigin = 'webhook' | 'poll';

export const gitlabWakeQueue = {
  /** Whether this delivery has already been handled (GitLab retries). */
  isDuplicate(deliveryId: string): boolean {
    return !!deliveryId && seen.has(deliveryId);
  },

  /**
   * Put one wake in the lane.
   *
   * Fire-and-forget on purpose: both callers are answering something else — a webhook that GitLab
   * disables if it is slow to reply, and a poll tick walking a page of to-dos — and neither has
   * anything to do with the row once it exists.
   */
  enqueue(item: Queued, origin: WakeOrigin = 'webhook'): void {
    if (item.deliveryId) {
      seen.add(item.deliveryId);
      // Unbounded growth over an uptime of months, for a set that only needs to remember the last
      // few minutes of deliveries — GitLab retries within seconds, not days.
      if (seen.size > 5_000) seen.clear();
    }
    const payload: GitLabRunPayload = { mode: 'wake', ...item };
    void runQueue
      .enqueue({
        source: 'gitlab',
        kind: item.kind,
        origin: origin === 'poll' ? `poll · ${item.kind}` : 'webhook',
        agentId: item.agentId,
        agentName: item.agentName,
        title: item.title,
        project: item.project,
        url: item.url,
        payload: payload as unknown as Record<string, unknown>,
        dedupeKey: item.deliveryId,
      })
      .catch((err) => log.error({ err: String(err), agent: item.agentName }, 'could not queue a gitlab wake'));
  },

  /**
   * Queue one operator-initiated turn — **Check now** (`GITLAB_PLAN.md` §10).
   *
   * Ahead of the wakes, because a person is standing in front of it waiting to see what the agent
   * says, and behind nothing else: the lane is still one turn at a time, so pressing the button
   * during a busy morning queues rather than doubling up on the inference server.
   */
  async enqueueTurn(input: {
    agentId: string;
    agentName: string;
    kind: string;
    origin: string;
    title: string;
    project?: string;
    brief: string;
    notify: string;
    readOnly?: boolean;
  }): Promise<RunQueueDoc | null> {
    const payload: GitLabRunPayload = {
      mode: 'turn',
      title: input.title,
      brief: input.brief,
      notify: input.notify,
      readOnly: input.readOnly,
    };
    return runQueue.enqueue({
      source: 'gitlab',
      kind: input.kind,
      origin: input.origin,
      agentId: input.agentId,
      agentName: input.agentName,
      title: input.title,
      project: input.project,
      payload: payload as unknown as Record<string, unknown>,
      priority: 10,
    });
  },
};

/**
 * How the lane runs a `gitlab` row. Registered at import time, before `runQueue.start()` — a row
 * left over from before a restart is claimed by the drain, and it has to find this.
 */
runQueue.register('gitlab', async (row, onSession) => {
  const payload = row.payload as unknown as GitLabRunPayload;
  const { sessionId, done } =
    payload.mode === 'wake'
      ? await startGitlabTurn({
          agentId: payload.agentId,
          agentName: payload.agentName,
          title: `GitLab · ${payload.title}`,
          brief: brief(payload),
          notify: `${payload.agentName} answered ${payload.title}`,
        })
      : await startGitlabTurn({
          agentId: row.agent_id,
          agentName: row.agent_name,
          title: payload.title,
          brief: payload.brief,
          notify: payload.notify,
          readOnly: payload.readOnly,
        });
  onSession(sessionId);
  await done;
});

/**
 * One headless GitLab turn, as an ordinary session the operator can open, watch and continue.
 *
 * Shared by the two things that start an agent from GitLab: a webhook wake, and the operator
 * pressing **Check now** on a project (`GITLAB_PLAN.md` §10). They differ only in the brief, so
 * they share everything else — and everything else is the part with the sharp edges: a
 * `TurnRecorder` off the EventBus (nobody is guaranteed to be watching, and a turn whose tool calls
 * only ever existed in a browser buffer is a turn lost), a `liveRuns` registration so the stop
 * button works, and a `SessionLock` yield so a live operator chat wins.
 *
 * Returns the session id as soon as it exists, with the turn itself still running, so the queue row
 * can be linked to the conversation while it streams — the operator watches the answer arrive
 * rather than waiting on it. `done` settles when the turn does, and **rejects** when it fails:
 * the lane awaits it, and that is what the row's `done`/`failed` is.
 */
export async function startGitlabTurn(input: {
  agentId: string;
  agentName: string;
  title: string;
  brief: string;
  /** Inbox line when the turn finishes. */
  notify: string;
  /** Refuse any call that would change something — what a *review* means (`GITLAB_PLAN.md` §12). */
  readOnly?: boolean;
}): Promise<{ sessionId: string; done: Promise<void> }> {
  const session = await sessionRepository.create({
    agentId: input.agentId,
    agentName: input.agentName,
    title: input.title.slice(0, 80),
    origin: 'gitlab',
  });
  const sessionId = String(session._id);
  const ctx: EventContext = { sessionId, agentId: input.agentId, agentName: input.agentName, depth: 0 };

  eventBus.emit('conversation:session_created', {
    sessionId,
    agentId: input.agentId,
    agentName: input.agentName,
    title: session.title,
    origin: 'gitlab',
  });

  await sessionRepository.addMessage(sessionId, { role: 'user', text: input.brief });
  eventBus.emit('chat:user_message', { ctx, content: input.brief });

  // Registered before the wait below, so a Workspace opening this session while it queues is told
  // the run is live rather than showing an idle conversation that suddenly sprouts an answer.
  const recorder = new TurnRecorder(sessionId, input.agentName);
  recorder.start();
  const controller = new AbortController();
  liveRuns.start(sessionId, recorder, controller);

  const done = (async () => {
    try {
      // A live operator chat on this agent wins. GitLab has already waited; it can wait a minute.
      await sessionLock.waitUntilFree(input.agentId, YIELD_TIMEOUT_MS);

      const result = await agentRunner.run({
        agentName: input.agentName,
        sessionId,
        depth: 0,
        userText: input.brief,
        signal: controller.signal,
        readOnly: input.readOnly === true,
      });
      const turn = recorder.build(result.text);
      await sessionRepository.addMessage(sessionId, {
        role: 'assistant',
        text: result.text,
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
        answer: result.text,
        blocks: turn.blocks as unknown[],
        memories: turn.memories,
        turnId: result.turnId,
        runId: result.runId,
      });
      // The operator's inbox: this ran while nobody was looking, so the only way they learn an agent
      // went and did something is a notification pointing at the session.
      await notificationRepository.create({
        agent_id: input.agentId,
        kind: 'gitlab',
        title: input.notify.slice(0, 200),
        content: result.text.slice(0, 500),
        ref_id: sessionId,
      });
      log.info({ agent: input.agentName, session: sessionId }, 'gitlab turn complete');
    } catch (err) {
      log.error({ err: String(err), agent: input.agentName, session: sessionId }, 'gitlab turn failed');
      // Rethrown, unlike before: the caller is now the run queue, and a row that says `done` after
      // an unreachable endpoint is exactly the lie the history exists to prevent.
      throw err;
    } finally {
      liveRuns.end(sessionId);
    }
  })();

  return { sessionId, done };
}
