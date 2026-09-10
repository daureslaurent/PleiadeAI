import { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { liveRuns } from '../../transport/ws/live-runs';
import { settingsService } from '../settings/settings.service';
import { ForumRuleError, forumService } from './forum.service';
import { forumTaskRepository } from './forum-task.repository';
import { forumPlanRepository } from './forum-plan.repository';
import { forumThreadRepository } from './forum-thread.repository';
import { forumPostRepository } from './forum-post.repository';
import { OPERATOR_AUTHOR, type ForumAuthor } from './forum-author';
import { loadRoster } from './forum-roster';
import { FORUM_DELIVERABLE_KINDS, type ForumTaskDoc, type ForumDeliverableKind } from './forum-task.model';
import type { ForumPlanDoc } from './forum-plan.model';

const log = createLogger('forum-task');

export interface DeliverableInput {
  kind: string;
  ref: string;
  note?: string;
}

/**
 * Resolve an agent name to a board author, the same way `parseMentions` does — against the live
 * roster, so an owner is always somebody the board could actually dispatch. Assigning work to a
 * misremembered name is exactly the silent stall this whole design removes, so it is a refusal
 * rather than a null.
 */
async function resolveAuthor(name: string | null | undefined, label: string): Promise<ForumAuthor | null> {
  const wanted = String(name ?? '').trim();
  if (!wanted) return null;
  if (wanted.toLowerCase() === 'operator') return OPERATOR_AUTHOR;
  const roster = await loadRoster();
  const hit = roster.byName.get(wanted.toLowerCase());
  if (!hit || hit.kind !== 'agent') {
    const known = [...roster.byName.values()].filter((r) => r.kind === 'agent').map((r) => r.name).join(', ');
    throw new ForumRuleError(`no agent called "${wanted}" for ${label}. Known agents: ${known}`, 404);
  }
  return { kind: 'agent', agent_id: hit.agentId, display_name: hit.name };
}

/**
 * Refuse a dependency edge that would close a cycle.
 *
 * A walk rather than a one-level rule (which is what `hub_thread_id` uses) because a dependency
 * graph is genuinely a graph — "verify depends on implement depends on design" is the shape this is
 * for, and flattening it to one level would make the useful case unexpressible. The walk is bounded
 * by the task count and only runs on writes, which are rare.
 */
async function assertNoCycle(taskId: string, depends: Types.ObjectId[]): Promise<void> {
  const seen = new Set<string>([taskId]);
  let frontier = depends.map(String);
  while (frontier.length) {
    if (frontier.some((id) => seen.has(id))) {
      throw new ForumRuleError('that dependency would create a cycle — a task cannot wait on itself', 400);
    }
    frontier.forEach((id) => seen.add(id));
    const docs = await forumTaskRepository.findMany(frontier);
    frontier = docs.flatMap((d) => d.depends_on.map(String));
  }
}

export const forumTaskService = {
  /**
   * File a task: a thread to discuss it in, and a task document that can be scheduled.
   *
   * The thread comes first and is not optional. A task with no discussion surface has nowhere to put
   * a review's reasons, a blocker's detail, or the operator's correction — and the board's whole
   * value is that the reasoning stays readable next to the work.
   */
  async fileTask(input: {
    goal: string;
    acceptance: string[];
    owner?: string | null;
    reviewer?: string | null;
    dependsOn?: string[];
    planId?: string | null;
    category?: string;
    detail?: string;
    author: ForumAuthor;
    byAgent: boolean;
  }): Promise<{ task: ForumTaskDoc; threadId: string }> {
    const goal = input.goal.trim();
    if (!goal) throw new ForumRuleError('a task needs a goal — one sentence saying what is true when it is done', 400);
    const acceptance = (input.acceptance ?? []).map((a) => String(a).trim()).filter(Boolean);
    if (!acceptance.length) {
      throw new ForumRuleError(
        'a task needs at least one acceptance criterion — what a different agent could check it ' +
          'against without asking you. "Implement the parser" is a wish; "parses the three files in ' +
          'fixtures/ and rejects the malformed fourth" is a task.',
        400,
      );
    }

    const plan = input.planId ? await forumPlanRepository.findById(input.planId) : null;
    if (input.planId && !plan) throw new ForumRuleError(`no such plan: "${input.planId}"`, 404);

    const owner = await resolveAuthor(input.owner, 'owner');
    const reviewer = await resolveAuthor(input.reviewer, 'reviewer');
    if (owner && reviewer && owner.agent_id && owner.agent_id === reviewer.agent_id) {
      throw new ForumRuleError(
        'a task cannot review itself — name a different agent as reviewer, or leave it empty to ' +
          "let the project's manager sign it off",
        400,
      );
    }

    const depends = await forumTaskRepository.findMany(input.dependsOn ?? []);
    if ((input.dependsOn ?? []).length !== depends.length) {
      throw new ForumRuleError('one of the tasks in depends_on does not exist', 404);
    }

    const { thread } = await forumService.createThread({
      category: input.category || 'general',
      title: goal.length > 110 ? `${goal.slice(0, 107)}…` : goal,
      body: [
        input.detail?.trim() || goal,
        '',
        '**Done when:**',
        ...acceptance.map((a) => `- ${a}`),
      ].join('\n'),
      author: input.author,
      byAgent: input.byAgent,
      hubThreadId: plan ? String(plan.hub_thread_id) : undefined,
      // The task carries the real state; these keep the thread list and the old work-item views
      // honest for anyone reading the board rather than the board page.
      assignee: owner,
      workState: 'todo',
    });

    const task = await forumTaskRepository.create({
      thread_id: thread._id,
      plan_id: plan?._id ?? null,
      goal,
      acceptance,
      owner,
      reviewer,
      depends_on: depends.map((d) => d._id),
      created_by: input.author,
    });
    log.info({ taskId: String(task._id), goal, owner: owner?.display_name ?? '(unowned)' }, 'task filed');
    return { task, threadId: String(thread._id) };
  },

  /**
   * Submit a deliverable. This is the write that makes `done` mean something.
   *
   * A task claiming completion with nothing to point at is the most expensive lie a board can tell,
   * because every task that depends on it then starts from a fiction — which is precisely what
   * `work_state: 'done'` allowed, since it asked for nothing at all. So the refusal is structural
   * and unconditional, and the task moves to `review` rather than `done`: its owner does not get to
   * sign off its own work.
   */
  async submit(input: {
    taskId: string;
    deliverable: DeliverableInput;
    note?: string;
    actor: ForumAuthor;
  }): Promise<ForumTaskDoc> {
    const task = await forumTaskRepository.findById(input.taskId);
    if (!task) throw new ForumRuleError(`no such task: "${input.taskId}"`, 404);
    if (task.state === 'done') throw new ForumRuleError('that task is already done', 409);
    if (task.state === 'cancelled') throw new ForumRuleError('that task was cancelled', 409);

    const kind = String(input.deliverable?.kind ?? '').trim() as ForumDeliverableKind;
    const ref = String(input.deliverable?.ref ?? '').trim();
    if (!FORUM_DELIVERABLE_KINDS.includes(kind) || !ref) {
      throw new ForumRuleError(
        'submitting needs a deliverable: `kind` one of ' +
          `${FORUM_DELIVERABLE_KINDS.join(' / ')} and \`ref\` pointing at it (a forum file id, a ` +
          'session resource handle, a post id, or a path/URL). If there is genuinely nothing to ' +
          'show, this is a `block`, not a submission.',
        400,
      );
    }

    const reviewer = task.reviewer ?? (await this.reviewerFor(task));
    const updated = await forumTaskRepository.update(task._id, {
      state: 'review',
      deliverable: {
        kind,
        ref,
        note: String(input.deliverable.note ?? input.note ?? '').trim(),
        submitted_by: input.actor.display_name,
        submitted_at: new Date(),
      },
      reviewer,
      blocked_on: '',
      'dispatch.session_id': null,
      'dispatch.kind': null,
    });
    await forumThreadRepository.update(String(task.thread_id), { work_state: 'in_progress' });
    log.info({ taskId: input.taskId, kind, reviewer: reviewer?.display_name }, 'task submitted for review');
    return updated!;
  },

  /**
   * A reviewer's verdict. Pass finishes the task; fail sends it back with reasons.
   *
   * `reasons` is required on a fail, and that is not politeness: a bounced task whose owner is not
   * told what was wrong is re-dispatched to do the same thing again, which spends the plan's
   * allowance on a loop nobody can see.
   */
  async review(input: {
    taskId: string;
    verdict: 'pass' | 'fail';
    reasons?: string;
    actor: ForumAuthor;
  }): Promise<ForumTaskDoc> {
    const task = await forumTaskRepository.findById(input.taskId);
    if (!task) throw new ForumRuleError(`no such task: "${input.taskId}"`, 404);
    if (task.state !== 'review') {
      throw new ForumRuleError(`that task is "${task.state}", not waiting on a review`, 409);
    }
    if (input.verdict === 'fail' && !input.reasons?.trim()) {
      throw new ForumRuleError(
        'a failed review has to say what is wrong — the owner is dispatched again from your reasons ' +
          'alone, so a bare "fail" buys another turn of the same work',
        400,
      );
    }

    if (input.verdict === 'pass') {
      const done = await forumTaskRepository.update(task._id, {
        state: 'done',
        done_at: new Date(),
        blocked_on: '',
        'dispatch.session_id': null,
        'dispatch.kind': null,
      });
      await forumThreadRepository.update(String(task.thread_id), { work_state: 'done' });
      log.info({ taskId: input.taskId, by: input.actor.display_name }, 'task accepted');
      return done!;
    }

    const settings = await settingsService.get();
    const rounds = task.review_rounds + 1;
    // Past the ceiling it stops bouncing and becomes the manager's problem. Two agents disagreeing
    // about what "done" means will not converge by repeating themselves at each other.
    const exhausted = rounds >= Math.max(1, settings.forum_task_max_review_rounds ?? 2);
    const failed = await forumTaskRepository.update(task._id, {
      state: exhausted ? 'blocked' : 'todo',
      review_rounds: rounds,
      blocked_on: exhausted
        ? `review failed ${rounds}× — last reason: ${input.reasons?.trim() ?? ''}`
        : '',
      'dispatch.session_id': null,
      'dispatch.kind': null,
    });
    log.info({ taskId: input.taskId, rounds, exhausted }, 'task bounced by review');
    return failed!;
  },

  /** Park a task and say what it is waiting for. The one signal that escalates a plan to its manager. */
  async block(input: { taskId: string; reason: string; actor: ForumAuthor }): Promise<ForumTaskDoc> {
    const task = await forumTaskRepository.findById(input.taskId);
    if (!task) throw new ForumRuleError(`no such task: "${input.taskId}"`, 404);
    const reason = input.reason?.trim();
    if (!reason) throw new ForumRuleError('say what you are blocked on, in one line', 400);
    const updated = await forumTaskRepository.update(task._id, {
      state: 'blocked',
      blocked_on: reason,
      'dispatch.session_id': null,
      'dispatch.kind': null,
    });
    await forumThreadRepository.update(String(task.thread_id), { work_state: 'blocked' });
    log.info({ taskId: input.taskId, reason }, 'task blocked');
    return updated!;
  },

  /**
   * Give back a claim whose run ended without the agent moving the task, and count it against the
   * leash: past `forum_task_max_dispatches` the task is blocked for the manager instead of requeued.
   *
   * Shared by the runner's own `finally` and the scheduler's reaper, because the cap used to live
   * only in the reaper — so the ordinary case, a dispatch that simply came back empty and was
   * released in-process, was requeued for ever and the cap counted nothing. A review that came back
   * empty stays a review: only work sent back to `todo` is work that has to be done again.
   */
  async releaseEmptyDispatch(taskId: string, maxDispatches: number): Promise<void> {
    const task = await forumTaskRepository.findById(taskId);
    if (!task) return;
    const spent = task.dispatch?.count ?? 0;
    if (spent >= Math.max(1, maxDispatches)) {
      await forumTaskRepository.releaseDispatch(task._id, 'blocked');
      await forumTaskRepository.update(task._id, {
        blocked_on:
          task.blocked_on ||
          `dispatched ${spent}× and came back without a submission — it may not be doable as written`,
      });
      log.warn({ taskId, spent }, 'task blocked after repeated empty dispatches');
      return;
    }
    await forumTaskRepository.releaseDispatch(task._id, task.state === 'doing' ? 'todo' : undefined);
    log.info({ taskId, spent }, 'dispatch ended without a submission — requeued');
  },

  /**
   * Force an in-flight claim off a task, stopping the run that holds it if one is still going.
   *
   * The reaper recovers a claim whose run died, but only on a tick and only after its grace window,
   * and a task nobody can see a way to unstick is one the operator has to fix in the database. This
   * is that escape hatch: it aborts the turn the way the chat's stop button does, then puts the task
   * back where the dispatch found it — `doing` came from `todo`, and a review stays a review.
   */
  async release(taskId: string): Promise<ForumTaskDoc> {
    const task = await forumTaskRepository.findById(taskId);
    if (!task) throw new ForumRuleError(`no such task: "${taskId}"`, 404);
    const sessionId = String(task.dispatch?.session_id ?? '');
    if (!sessionId) throw new ForumRuleError('nothing is running on this task', 409);

    liveRuns.get(sessionId)?.controller?.abort();
    const released = await forumTaskRepository.releaseDispatch(
      task._id,
      task.state === 'doing' ? 'todo' : undefined,
    );
    log.info({ taskId, sessionId, state: released?.state }, 'in-flight claim released by operator');
    return released!;
  },

  /** Operator-side edits: owner, reviewer, dependencies, state, acceptance. */
  async patch(taskId: string, body: Record<string, unknown>): Promise<ForumTaskDoc> {
    const task = await forumTaskRepository.findById(taskId);
    if (!task) throw new ForumRuleError(`no such task: "${taskId}"`, 404);
    const set: Record<string, unknown> = {};
    if (typeof body.goal === 'string' && body.goal.trim()) set.goal = body.goal.trim();
    if (Array.isArray(body.acceptance)) {
      set.acceptance = body.acceptance.map((a) => String(a).trim()).filter(Boolean);
    }
    if (body.owner !== undefined) set.owner = await resolveAuthor(body.owner as string, 'owner');
    if (body.reviewer !== undefined) set.reviewer = await resolveAuthor(body.reviewer as string, 'reviewer');
    if (typeof body.state === 'string') set.state = body.state;
    if (Array.isArray(body.dependsOn)) {
      const deps = await forumTaskRepository.findMany(body.dependsOn as string[]);
      await assertNoCycle(taskId, deps.map((d) => d._id));
      set.depends_on = deps.map((d) => d._id);
    }
    if (body.planId !== undefined) {
      set.plan_id = body.planId ? new Types.ObjectId(String(body.planId)) : null;
    }
    // Re-dispatching a task the operator un-blocked is the point of editing it, so clear the claim.
    if (set.state && set.state !== 'doing') {
      set['dispatch.session_id'] = null;
      set['dispatch.kind'] = null;
    }
    return (await forumTaskRepository.update(taskId, set))!;
  },

  /**
   * Who signs this task off when it names nobody: the plan's manager, or the operator for a
   * standalone task. Never the owner — that is the one substitution that would give `work_state`
   * back.
   */
  async reviewerFor(task: ForumTaskDoc): Promise<ForumAuthor | null> {
    if (task.reviewer) return task.reviewer;
    if (!task.plan_id) return OPERATOR_AUTHOR;
    const plan = await forumPlanRepository.findById(task.plan_id);
    if (!plan) return OPERATOR_AUTHOR;
    if (plan.manager.agent_id && plan.manager.agent_id === task.owner?.agent_id) return OPERATOR_AUTHOR;
    return plan.manager;
  },

  /** The board's read model for one task: the task plus enough thread context to render it. */
  async detail(taskId: string): Promise<Record<string, unknown> | null> {
    const task = await forumTaskRepository.findById(taskId);
    if (!task) return null;
    const [thread, deps, plan] = await Promise.all([
      forumThreadRepository.findById(String(task.thread_id)),
      forumTaskRepository.findMany(task.depends_on),
      task.plan_id ? forumPlanRepository.findById(task.plan_id) : Promise.resolve(null),
    ]);
    return {
      ...serialiseTask(task),
      threadTitle: thread?.title ?? '',
      postCount: thread?.post_count ?? 0,
      planGoal: plan?.goal ?? '',
      dependsOnTasks: deps.map((d) => ({ id: String(d._id), goal: d.goal, state: d.state })),
    };
  },

  /**
   * The last few posts on a task's thread, as context for whoever is dispatched onto it.
   *
   * Capped hard: a dispatch brief that grows with the discussion is a brief that eventually costs
   * more than the work, and the agent can always `read_thread` for the rest.
   */
  async recentDiscussion(threadId: Types.ObjectId, limit = 4): Promise<string[]> {
    const posts = await forumPostRepository.listByThread(String(threadId), 50, 0);
    return posts
      .slice(-limit)
      .map((p) => `${p.author.display_name}: ${p.body.length > 400 ? `${p.body.slice(0, 400)}…` : p.body}`);
  },
};

/** One shape for a task on the wire, so the board page and the tool agree on field names. */
export function serialiseTask(task: ForumTaskDoc): Record<string, unknown> {
  return {
    id: String(task._id),
    threadId: String(task.thread_id),
    planId: task.plan_id ? String(task.plan_id) : null,
    goal: task.goal,
    acceptance: task.acceptance,
    owner: task.owner,
    reviewer: task.reviewer,
    dependsOn: task.depends_on.map(String),
    state: task.state,
    deliverable: task.deliverable,
    blockedOn: task.blocked_on,
    reviewRounds: task.review_rounds,
    dispatchCount: task.dispatch?.count ?? 0,
    inFlight: Boolean(task.dispatch?.session_id),
    sessionId: task.dispatch?.session_id ? String(task.dispatch.session_id) : null,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    doneAt: task.done_at,
  };
}

/** The same, for a plan. */
export function serialisePlan(plan: ForumPlanDoc): Record<string, unknown> {
  return {
    id: String(plan._id),
    hubThreadId: String(plan.hub_thread_id),
    goal: plan.goal,
    manager: plan.manager,
    state: plan.state,
    turnsSpent: plan.turns_spent,
    turnsMax: plan.turns_max,
    revision: plan.revision,
    escalation: plan.escalation,
    lastManagerAt: plan.last_manager_at,
    createdAt: plan.created_at,
    finishedAt: plan.finished_at,
  };
}
