import { createLogger } from '../../config/logger';
import { settingsService } from '../settings/settings.service';
import { agentRepository } from '../agents/agent.repository';
import { sessionRepository } from '../sessions/session.repository';
import { eventBus } from '../../core/event-bus/EventBus';
import { ForumRuleError, forumService } from './forum.service';
import { forumPlanRepository } from './forum-plan.repository';
import { forumTaskRepository } from './forum-task.repository';
import { forumTaskService } from './forum-task.service';
import { forumTaskRunner } from './forum-task-runner';
import { liveRuns } from '../../transport/ws/live-runs';
import { OPERATOR_AUTHOR, type ForumAuthor } from './forum-author';
import type { ForumPlanDoc, ForumPlanKind } from './forum-plan.model';
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
export async function resolveManager(agentId?: string | null): Promise<ForumAuthor> {
  // A manager picked on the create form wins (`BOARD_REFACTOR_PLAN.md` §3); the fleet setting is
  // its default, not a constraint.
  if (agentId) {
    const picked = await agentRepository.findById(agentId).catch(() => null);
    if (!picked) throw new ForumRuleError('the agent picked as project manager does not exist', 404);
    return { kind: 'agent', agent_id: String(picked._id), display_name: picked.name };
  }
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
        '**Fix the plan and stop.** Leave `plan_id` out — you are already in this project. Use ' +
          '`board` `file_task` to add what is missing, `board` ' +
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
        'Leave `plan_id` out — every task you file lands in this project automatically. Do not file ' +
          'tasks for anything outside it.',
        '',
        'Prefer four large tasks to twelve small ones — every task costs at least two agent turns, ' +
          `and this project has ${plan.turns_max}.`,
        '',
        '**Plan it wide, and plan it collision-free.** Several tasks run *at the same time* here, so:',
        '',
        '- Use `depends_on` only where one task genuinely cannot start until another has finished. ' +
          'A dependency added "to be safe" costs real time: it forces two tasks that could have run ' +
          'together to run one after the other.',
        '- Never leave two tasks that can run at once writing the same file, the same directory or ' +
          'the same record. Nothing stops them colliding. Split the work by *what it touches*, not ' +
          'by the order you imagined it happening in — and where two pieces must touch the same ' +
          'thing, make one depend on the other.',
        '- Each task must be finishable by its owner alone. One that needs an answer from a task ' +
          'still in flight is a dependency you forgot to declare.',
        '',
        'The agents doing this work may be running on a smaller model than yours. Write acceptance ' +
          'criteria that can be *checked* rather than interpreted, keep each task to one objective, ' +
          'and put everything it needs into its `goal` — it cannot ask you what you meant.',
        '',
        'File them all, then stop. Nothing needs to be announced and nobody needs to be woken: the ' +
          'board dispatches each task the moment everything it depends on is accepted.',
      ];
  return head.join('\n');
}

export const forumPlanService = {
  /**
   * Open a board item: a hub thread, a plan document, its PM conversation — and then either its one
   * task (a `task`) or a manager turn to fill the graph (a `project`).
   *
   * The plan starts `draft` and dispatches nothing. That is not ceremony: the manager is an LLM and
   * a bad plan dispatches exactly as confidently as a good one, so the operator reads the graph
   * before anything spends a turn on it. A `task` is filed straight from the form because the
   * operator (or the analyser) has already written its contract — planning it would pay a manager
   * turn to restate what is on the screen.
   */
  async create(input: {
    goal: string;
    kind?: ForumPlanKind;
    name?: string;
    description?: string;
    acceptance?: string[];
    managerAgentId?: string | null;
    owner?: string | null;
    reviewer?: string | null;
    category?: string;
    author: ForumAuthor;
    turnsMax?: number;
  }): Promise<ForumPlanDoc> {
    const goal = input.goal.trim();
    if (!goal) throw new ForumRuleError('a board item needs a prompt — what you want done', 400);
    const kind: ForumPlanKind = input.kind === 'task' ? 'task' : 'project';
    const name = (input.name ?? '').trim() || (goal.length > 80 ? `${goal.slice(0, 77)}…` : goal);
    const description = (input.description ?? '').trim();
    const acceptance = (input.acceptance ?? []).map((a) => String(a).trim()).filter(Boolean);
    if (kind === 'task') {
      if (!input.owner?.trim()) throw new ForumRuleError('a task needs an owner — the agent that does it', 400);
      if (!acceptance.length) {
        throw new ForumRuleError('a task needs at least one acceptance criterion — what its reviewer checks', 400);
      }
    }
    const settings = await settingsService.get();
    const manager = await resolveManager(input.managerAgentId);

    const { thread } = await forumService.createThread({
      category: input.category || 'general',
      title: name.length > 110 ? `${name.slice(0, 107)}…` : name,
      body: [
        `**${kind === 'task' ? 'Task' : 'Project'}.** ${description || goal}`,
        '',
        description ? `Asked for: ${goal}` : '',
        '',
        `Managed by ${manager.display_name}. Tasks appear as threads under this one.`,
      ]
        .filter((l, i, all) => l !== '' || all[i - 1] !== '')
        .join('\n'),
      author: input.author,
      byAgent: input.author.kind === 'agent',
    });

    let plan = await forumPlanRepository.create({
      hub_thread_id: thread._id,
      kind,
      name,
      description,
      acceptance,
      goal,
      manager,
      state: 'draft',
      turns_max: Math.max(1, input.turnsMax || settings.forum_plan_max_turns || 60),
      created_by: input.author,
    });
    plan = await this.ensureChatSession(plan);
    log.info({ planId: String(plan._id), kind, name, manager: manager.display_name }, 'board item opened');

    if (kind === 'task') {
      try {
        await forumTaskService.fileTask({
          goal: description || name,
          acceptance,
          owner: input.owner,
          reviewer: input.reviewer || null,
          planId: String(plan._id),
          detail: description ? `${description}\n\nAsked for: ${goal}` : goal,
          author: input.author,
          byAgent: input.author.kind === 'agent',
        });
      } catch (err) {
        // The form was valid but the task was not (an unknown owner, owner = reviewer): take the
        // empty item back out rather than leave a task with no task on the board.
        await forumPlanRepository.remove(String(plan._id));
        throw err;
      }
    } else {
      await this.runManager(String(plan._id), '').catch((err) =>
        log.error({ err: String(err), planId: String(plan._id) }, 'initial planning turn failed to start'),
      );
    }
    return (await forumPlanRepository.findById(plan._id)) ?? plan;
  },

  /**
   * The item's PM conversation, made on first need (`BOARD_REFACTOR_PLAN.md` §3). Plans from before
   * the refactor have none until the page opens them, and a manager that has since been deleted
   * leaves the old session pointing at nobody — the page then says so instead of crashing.
   */
  async ensureChatSession(plan: ForumPlanDoc): Promise<ForumPlanDoc> {
    if (plan.chat_session_id) {
      const existing = await sessionRepository.findById(String(plan.chat_session_id));
      if (existing) return plan;
    }
    const agent = plan.manager.agent_id ? await agentRepository.findById(plan.manager.agent_id) : null;
    if (!agent) return plan;
    const session = await sessionRepository.create({
      agentId: agent._id,
      agentName: agent.name,
      title: `PM: ${plan.name || plan.goal}`.slice(0, 120),
      origin: 'board',
      boardPlanId: plan._id,
    });
    eventBus.emit('conversation:session_created', {
      sessionId: String(session._id),
      agentId: String(agent._id),
      agentName: agent.name,
      title: session.title,
      origin: 'board',
    });
    return (await forumPlanRepository.update(plan._id, { chat_session_id: session._id })) ?? plan;
  },

  /** Send the manager in to write (or rewrite) the graph. One turn, and it dispatches nothing itself. */
  async runManager(planId: string, escalation: string): Promise<{ sessionId: string } | null> {
    const found = await forumPlanRepository.findById(planId);
    if (!found) throw new ForumRuleError(`no such plan: "${planId}"`, 404);
    if (found.manager_session_id) return null;
    // Manager turns land in the item's PM conversation, so the chat is the project's whole history.
    const plan = await this.ensureChatSession(found);
    const chatSessionId = plan.chat_session_id ? String(plan.chat_session_id) : '';
    // The operator is mid-conversation with this manager: a board turn racing it in the same session
    // would interleave two turns' messages. The scheduler simply tries again next tick.
    if (chatSessionId && liveRuns.has(chatSessionId)) {
      log.info({ planId }, 'manager turn deferred — the operator is talking to the manager');
      return null;
    }

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
    const session = chatSessionId ? await sessionRepository.findById(chatSessionId) : null;
    if (!session) throw new ForumRuleError('this item has no manager conversation', 409);
    const sessionId = String(session._id);
    const claimed = await forumPlanRepository.claimManager(plan._id, session._id as never);
    if (!claimed) return null;

    const text = planBrief(plan, tasks, escalation);
    void forumTaskRunner
      .drive(sessionId, agent.name, String(agent._id), text, null, {
        board: { planId: String(plan._id), mode: 'auto' },
        source: 'board',
      })
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
