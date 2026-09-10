import { createLogger } from '../../config/logger';
import { settingsService } from '../settings/settings.service';
import { agentRepository } from '../agents/agent.repository';
import { sessionRepository } from '../sessions/session.repository';
import { eventBus } from '../../core/event-bus/EventBus';
import { ForumRuleError, forumService } from './forum.service';
import { forumPlanRepository } from './forum-plan.repository';
import { forumTaskRepository } from './forum-task.repository';
import { forumTaskRunner } from './forum-task-runner';
import { OPERATOR_AUTHOR, type ForumAuthor } from './forum-author';
import type { ForumPlanDoc } from './forum-plan.model';
import type { ForumTaskDoc } from './forum-task.model';

const log = createLogger('forum-plan');

/**
 * Which agent plans projects.
 *
 * An ordinary operator-owned agent, resolved by name, rather than a built-in like `forum_keeper`.
 * The moderator had to be a built-in because its powers are authorised in code — `forum_admin`
 * checks `builtin === 'forum_moderator'` on every call, so the capability cannot be granted by
 * dropping a tool into somebody's `tools_allowed`. A planner has no such powers: its entire output
 * is task documents the operator can read, edit and delete. Making it a built-in would buy nothing
 * and cost the operator the ability to retune or replace it.
 */
export async function resolveManager(): Promise<ForumAuthor> {
  const settings = await settingsService.get();
  const wanted = (settings.forum_project_manager_agent || 'project_manager').trim();
  const agent = await agentRepository.findByName(wanted);
  if (!agent) {
    throw new ForumRuleError(
      `no agent called "${wanted}" to manage projects — set one in Settings → Forum, or create an ` +
        'agent by that name',
      404,
    );
  }
  return { kind: 'agent', agent_id: String(agent._id), display_name: agent.name };
}

/**
 * What the manager is told when it plans, and when it replans.
 *
 * The planning brief is where the whole design's economics are set: the manager is asked for a
 * *graph*, once, rather than for a decision every hop. Getting acceptance criteria out of it is the
 * part that matters — a task whose criteria are "implement the parser" cannot be reviewed, so it
 * cannot be finished, so it stalls the plan exactly the way the old board stalled.
 */
function planBrief(plan: ForumPlanDoc, tasks: ForumTaskDoc[], escalation: string): string {
  const head = tasks.length
    ? [
        `**Replan — project \`${String(plan._id)}\`**`,
        '',
        `Goal: *${plan.goal}*`,
        '',
        `Why you were called: ${escalation}`,
        '',
        'Where the plan stands:',
        ...tasks.map(
          (t) =>
            `- \`${String(t._id)}\` [${t.state}] ${t.goal}` +
            `${t.owner ? ` — ${t.owner.display_name}` : ' — unowned'}` +
            `${t.blocked_on ? ` · blocked on: ${t.blocked_on}` : ''}` +
            `${t.depends_on.length ? ` · waits on ${t.depends_on.length}` : ''}`,
        ),
        '',
        `Turns spent: ${plan.turns_spent}/${plan.turns_max}. Revision ${plan.revision}.`,
        '',
        '**Fix the plan and stop.** Use `board` `file_task` to add what is missing, `board` ' +
          '`patch_task` to reassign, re-scope or cancel what is stuck, and `board` `finish_plan` if ' +
          'the goal is actually met. Then say in one paragraph what you changed and why.',
        '',
        'Do not re-explain the parts that are working, do not summarise the project, and do not post ' +
          'on any thread to tell anybody about this — the board dispatches the work itself.',
      ]
    : [
        `**Plan the project \`${String(plan._id)}\`**`,
        '',
        `Goal: *${plan.goal}*`,
        '',
        'Break it into tasks with `board` `file_task`. For each one:',
        '',
        '- `goal` — one sentence saying what is true when it is finished.',
        '- `acceptance` — the criteria a *different* agent could check it against without asking ' +
          'you. This is the part that matters: "implement the parser" is a wish, "parses the three ' +
          'files in fixtures/ and rejects the malformed fourth" is a task.',
        '- `owner` — the agent that will do it.',
        '- `reviewer` — a different agent that will sign it off. Never the owner.',
        '- `depends_on` — the task ids that must finish first. File them in order and the ids are ' +
          'yours to reference.',
        '',
        'Prefer four large tasks to twelve small ones — every task costs at least two agent turns, ' +
          `and this project has ${plan.turns_max}.`,
        '',
        'File them all, then stop. Nothing needs to be announced and nobody needs to be woken: the ' +
          'board dispatches each task the moment everything it depends on is accepted.',
      ];
  return head.join('\n');
}

export const forumPlanService = {
  /**
   * Open a project: a hub thread, a plan document, and — unless told otherwise — a manager turn to
   * fill it with tasks.
   *
   * The plan starts `draft` and dispatches nothing. That is not ceremony: the manager is an LLM and
   * a bad plan dispatches exactly as confidently as a good one, so the operator reads the graph
   * before anything spends a turn on it.
   */
  async create(input: {
    goal: string;
    category?: string;
    author: ForumAuthor;
    turnsMax?: number;
  }): Promise<ForumPlanDoc> {
    const goal = input.goal.trim();
    if (!goal) throw new ForumRuleError('a project needs a goal', 400);
    const settings = await settingsService.get();
    const manager = await resolveManager();

    const { thread } = await forumService.createThread({
      category: input.category || 'general',
      title: goal.length > 110 ? `${goal.slice(0, 107)}…` : goal,
      body: [`**Project.** ${goal}`, '', `Planned by ${manager.display_name}. Tasks appear as threads under this one.`].join('\n'),
      author: input.author,
      byAgent: input.author.kind === 'agent',
    });

    const plan = await forumPlanRepository.create({
      hub_thread_id: thread._id,
      goal,
      manager,
      state: 'draft',
      turns_max: Math.max(1, input.turnsMax || settings.forum_plan_max_turns || 60),
      created_by: input.author,
    });
    log.info({ planId: String(plan._id), goal, manager: manager.display_name }, 'project opened');
    return plan;
  },

  /** Send the manager in to write (or rewrite) the graph. One turn, and it dispatches nothing itself. */
  async runManager(planId: string, escalation: string): Promise<{ sessionId: string } | null> {
    const plan = await forumPlanRepository.findById(planId);
    if (!plan) throw new ForumRuleError(`no such plan: "${planId}"`, 404);
    if (plan.manager_session_id) return null;

    const settings = await settingsService.get();
    if (plan.revision >= Math.max(1, settings.forum_plan_max_revisions ?? 6)) {
      await forumPlanRepository.update(plan._id, {
        state: 'blocked',
        escalation: `the manager has revised this plan ${plan.revision}× — it needs you`,
      });
      log.warn({ planId, revision: plan.revision }, 'plan hit its revision ceiling');
      return null;
    }

    const spent = await forumPlanRepository.claimTurn(plan._id);
    if (spent === null) {
      await forumPlanRepository.update(plan._id, {
        state: 'blocked',
        escalation: `out of turns (${plan.turns_max} spent)`,
      });
      return null;
    }

    const agent = plan.manager.agent_id ? await agentRepository.findById(plan.manager.agent_id) : null;
    if (!agent) throw new ForumRuleError('the project manager agent no longer exists', 404);

    const tasks = await forumTaskRepository.listByPlan(plan._id);
    const session = await sessionRepository.create({
      agentId: agent._id,
      agentName: agent.name,
      title: tasks.length ? `Replan: ${plan.goal}` : `Plan: ${plan.goal}`,
      origin: 'forum',
      forumThreadId: plan.hub_thread_id,
    });
    const sessionId = String(session._id);
    const claimed = await forumPlanRepository.claimManager(plan._id, session._id as never);
    if (!claimed) return null;

    eventBus.emit('conversation:session_created', {
      sessionId,
      agentId: String(agent._id),
      agentName: agent.name,
      title: session.title,
      origin: 'forum',
    });

    const text = planBrief(plan, tasks, escalation);
    void forumTaskRunner
      .drive(sessionId, agent.name, String(agent._id), text)
      .catch((err) => log.error({ err: String(err), planId }, 'manager turn failed'))
      .finally(async () => {
        await forumPlanRepository.releaseManager(plan._id);
        // A planning turn that produced tasks moves the plan on by itself. A replan bumps the
        // revision counter whether or not it changed anything — a manager that keeps being called
        // and keeps changing nothing is exactly what the ceiling is for.
        const after = await forumPlanRepository.findById(planId);
        const filed = await forumTaskRepository.listByPlan(plan._id);
        if (!after) return;
        await forumPlanRepository.update(plan._id, {
          revision: tasks.length ? after.revision + 1 : after.revision,
          escalation: '',
          state: filed.length && after.state === 'blocked' ? 'running' : after.state,
        });
      });

    log.info({ planId, sessionId, escalation: escalation || 'initial plan' }, 'manager dispatched');
    return { sessionId };
  },

  /** Operator: start a drafted plan running, or stop a running one. */
  async setState(planId: string, state: 'draft' | 'running' | 'blocked' | 'done' | 'cancelled'): Promise<ForumPlanDoc> {
    const plan = await forumPlanRepository.findById(planId);
    if (!plan) throw new ForumRuleError(`no such plan: "${planId}"`, 404);
    if (state === 'running') {
      const tasks = await forumTaskRepository.listByPlan(plan._id);
      if (!tasks.length) {
        throw new ForumRuleError(
          'this project has no tasks yet — plan it first (the manager fills the graph), or file ' +
            'tasks by hand',
          409,
        );
      }
    }
    const patch: Record<string, unknown> = { state, escalation: '' };
    if (state === 'done' || state === 'cancelled') patch.finished_at = new Date();
    return (await forumPlanRepository.update(planId, patch))!;
  },

  /** Mark a project finished. Called by the manager through the tool, and by the operator. */
  async finish(planId: string, actor: ForumAuthor): Promise<ForumPlanDoc> {
    log.info({ planId, by: actor.display_name }, 'project finished');
    return this.setState(planId, 'done');
  },
};

export const operatorAuthor = OPERATOR_AUTHOR;
