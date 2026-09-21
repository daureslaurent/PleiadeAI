import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import type { EventContext } from '../../core/event-bus/events.types';
import { sessionLock } from '../../core/session/SessionLock';
import { agentRunner } from '../../orchestrator/AgentRunner';
import { liveRuns } from '../../transport/ws/live-runs';
import { TurnRecorder } from '../../transport/ws/TurnRecorder';
import { notificationRepository } from '../notifications/notification.repository';
import { sessionRepository } from '../sessions/session.repository';
import type { WakeDecision } from './gitlab-webhook.service';

const log = createLogger('gitlab-wake');

/** How long a woken run waits for a live operator chat on the same agent before giving up. */
const YIELD_TIMEOUT_MS = 60_000;

/** How much of the triggering text is quoted into the brief before it is cut. */
const MAX_QUOTE_CHARS = 4_000;

/**
 * GitLab wakes (`GITLAB_PLAN.md` §5), modelled on `forum-mention-runner.ts`.
 *
 * A **queue**, not a fan-out, and for the same reason the forum's is: two agents woken by the same
 * thread have to see each other's posted comments, which only exist once the first run has
 * finished. Serial also means an afternoon of GitLab activity cannot start twelve inference runs at
 * once on a single-GPU fleet.
 *
 * In memory rather than a collection, again following the forum: a restart mid-queue drops what had
 * not started yet, which is the honest failure mode for a convenience — GitLab still holds the
 * issue, and the agent will see it next time it looks.
 */
interface Queued extends WakeDecision {
  deliveryId: string;
  agentId: string;
  agentName: string;
}

const queue: Queued[] = [];
/** Deliveries already handled — GitLab retries a hook it thinks failed. */
const seen = new Set<string>();
let draining = false;

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
 */
function brief(item: Queued): string {
  const where = item.kind === 'merge_request' ? 'merge request' : item.kind === 'note' ? 'comment' : 'issue';
  const opening =
    item.kind === 'issue'
      ? `You have been assigned an issue on GitLab: **${item.title}** in \`${item.project}\`.`
      : item.kind === 'merge_request'
        ? `You have been asked to review a merge request on GitLab: **${item.title}** in \`${item.project}\`.`
        : `You were named in a comment on GitLab, on **${item.title}** in \`${item.project}\`.`;

  return [
    opening,
    '',
    `The ${where} says:`,
    '',
    quote(item.body || '(no description)'),
    '',
    item.url ? `It is at ${item.url}.` : '',
    '',
    'Work it with the `gitlab_*` tools. Read before you act: fetch the issue or the merge request, ' +
      'look at the code it concerns, and check whether somebody has already answered.',
    '',
    item.kind === 'merge_request'
      ? '**Finish by reviewing on the merge request itself** — `gitlab_mr({action:"comment"})`, with ' +
        '`path` and `line` when your point is about a specific line. Read the whole `diff` first. If ' +
        'it is good, say so and `approve`; if it is not, say exactly what would have to change.'
      : '**Finish by commenting on the issue** — `gitlab_issue({action:"comment"})` — with what you ' +
        'found, what you did, and what you need from a human if you are blocked. Close it only when ' +
        'the work is genuinely done, and say in the closing comment how it was verified.',
    '',
    'Your answer here is not delivered anywhere by itself: the tool call is what other people see. ' +
      'If there is nothing useful to add, say so in one line rather than restating what the thread ' +
      'already says.',
  ]
    .filter(Boolean)
    .join('\n');
}

export const gitlabWakeQueue = {
  /** Whether this delivery has already been handled (GitLab retries). */
  isDuplicate(deliveryId: string): boolean {
    return !!deliveryId && seen.has(deliveryId);
  },

  enqueue(item: Queued): void {
    if (item.deliveryId) {
      seen.add(item.deliveryId);
      // Unbounded growth over an uptime of months, for a set that only needs to remember the last
      // few minutes of deliveries — GitLab retries within seconds, not days.
      if (seen.size > 5_000) seen.clear();
    }
    queue.push(item);
    log.info({ agent: item.agentName, kind: item.kind, project: item.project, depth: queue.length }, 'gitlab wake queued');
    void drain();
  },

  depth(): number {
    return queue.length;
  },
};

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        await run(item);
      } catch (err) {
        log.error({ err: String(err), agent: item.agentName }, 'gitlab wake run failed');
      }
    }
  } finally {
    draining = false;
  }
}

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
 * Returns the session id as soon as it exists, with the turn itself still running: a caller that
 * waited would hang for the length of an inference call, and the point is to *watch* the answer
 * arrive. `done` is offered for the wake queue, which drains strictly one at a time.
 */
export async function startGitlabTurn(input: {
  agentId: string;
  agentName: string;
  title: string;
  brief: string;
  /** Inbox line when the turn finishes. */
  notify: string;
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
    } finally {
      liveRuns.end(sessionId);
    }
  })();

  return { sessionId, done };
}

/** One woken turn, from a webhook. */
async function run(item: Queued): Promise<void> {
  const { done } = await startGitlabTurn({
    agentId: item.agentId,
    agentName: item.agentName,
    title: `GitLab · ${item.title}`,
    brief: brief(item),
    notify: `${item.agentName} answered ${item.title}`,
  });
  await done;
}
