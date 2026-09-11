import { createLogger } from '../../config/logger';
import { forumTaskService, serialisePlan, serialiseTask } from '../../domain/forum/forum-task.service';
import { forumTaskRepository } from '../../domain/forum/forum-task.repository';
import { forumPlanRepository } from '../../domain/forum/forum-plan.repository';
import { forumPlanService } from '../../domain/forum/forum-plan.service';
import { ForumRuleError } from '../../domain/forum/forum.service';
import type { ForumAuthor } from '../../domain/forum/forum-author';
import type { Tool, ToolResult } from '../types';

const log = createLogger('tool:board');

/**
 * The work surface (spec `FORUM_WORKBOARD_PLAN.md`).
 *
 * Split from `forum` rather than added to it, because the two answer different questions and the
 * split is the design: **`forum` is where the fleet talks, `board` is where its work lives.** A post
 * is prose somebody may read; a task is a state machine the scheduler acts on. Folding the second
 * into the first is exactly how `work_state` ended up a label nobody could check.
 *
 * The surface is deliberately small. An agent doing a task needs three verbs — finish it, get stuck,
 * or judge somebody else's — and every one of them ends its turn. Only the manager files tasks, and
 * only because planning is its whole job.
 */
/** The `board` verbs that only read. `submit` / `review` / `block` / the planning verbs all write. */
const BOARD_READ_ACTIONS = new Set(['my_tasks', 'read_task', 'list_plan']);

export const board: Tool = {
  name: 'board',
  // Reading what you own while reading a task is safe; two writes to the same plan in one batch are
  // not — a `submit` and a `review` racing would reorder a task's state transitions.
  parallelSafe: (args) => BOARD_READ_ACTIONS.has(String(args.action ?? '')),
  description:
    'The work board: tasks, their deliverables and their reviews. This is where work *is*, as ' +
    'opposed to the `forum`, which is where it is discussed. ' +
    'You do not have to look for work here — the board dispatches a task to you when everything it ' +
    'depends on is finished, and tells you so. ' +
    'When you are given a task, end your turn with `submit` (a deliverable that satisfies the ' +
    'acceptance criteria) or `block` (one line on what you are waiting for). When you are given a ' +
    'review, end it with `review`: pass or fail, and on a fail say exactly what is missing. ' +
    'A task cannot be marked done by the agent that did it — somebody else signs it off — and it ' +
    'cannot be finished without a deliverable that a reviewer can open. ' +
    '`file_task` and `plan` are for planning a project: state the goal, the acceptance criteria a ' +
    'different agent could check without asking you, the owner, and what it waits on.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'my_tasks',
          'read_task',
          'submit',
          'block',
          'review',
          'file_task',
          'patch_task',
          'list_plan',
          'finish_plan',
        ],
        description:
          'my_tasks: what you own and what is waiting on your review. read_task: one task in full. ' +
          'submit: finish a task with a deliverable. block: park it, saying what you need. ' +
          'review: pass or fail a submitted task. file_task / patch_task / list_plan / finish_plan: ' +
          'planning verbs.',
      },
      task_id: { type: 'string', description: 'The task, for read_task / submit / block / review / patch_task.' },
      plan_id: {
        type: 'string',
        description:
          'The project, for file_task / list_plan / finish_plan. Omit it while you are planning a ' +
          'project — the board knows which one you are in and files against it.',
      },
      goal: { type: 'string', description: 'For file_task: one sentence saying what is true when it is finished.' },
      acceptance: {
        type: 'array',
        items: { type: 'string' },
        description:
          'For file_task: the criteria a *different* agent could check this against without asking ' +
          'you. Required. "Implement the parser" is a wish; "parses the three files in fixtures/ ' +
          'and rejects the malformed fourth" is a criterion.',
      },
      owner: { type: 'string', description: 'For file_task / patch_task: the agent that does the work, by exact name.' },
      reviewer: {
        type: 'string',
        description:
          'For file_task / patch_task: the agent that signs it off, by exact name. Never the owner. ' +
          "Empty leaves it to the project's manager.",
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'For file_task / patch_task: task ids that must be accepted before this one runs.',
      },
      detail: { type: 'string', description: 'For file_task: the opening post on the task thread — context the owner needs.' },
      deliverable: {
        type: 'object',
        description:
          'For submit. `kind`: "attachment" (a forum file id), "handle" (a session resource like ' +
          'img_1), "post" (a post id, when the output genuinely is prose), or "external" (a path or ' +
          'a URL). `ref`: the thing itself. `note`: one line on what it is.',
        properties: {
          kind: { type: 'string', enum: ['attachment', 'handle', 'post', 'external'] },
          ref: { type: 'string' },
          note: { type: 'string' },
        },
      },
      verdict: { type: 'string', enum: ['pass', 'fail'], description: 'For review.' },
      reasons: { type: 'string', description: 'For review with verdict "fail": exactly what is missing. Required.' },
      reason: { type: 'string', description: 'For block: one line on what you are waiting for.' },
      state: { type: 'string', description: 'For patch_task: a new state, when the plan needs one forced.' },
    },
    required: ['action'],
  },

  async execute(args, ctx): Promise<ToolResult> {
    /** Identity from the run, never from `args` — the same rule the board's authorship has always had. */
    const actor: ForumAuthor = { kind: 'agent', agent_id: ctx.agentId, display_name: ctx.agentName };
    const action = String(args.action ?? '').trim();
    const str = (k: string): string => String(args[k] ?? '').trim();
    const arr = (k: string): string[] => (Array.isArray(args[k]) ? (args[k] as unknown[]).map(String) : []);

    /**
     * The project this call belongs to, without asking the model to remember it.
     *
     * A manager plans inside a session that holds the plan's manager slot for the length of the
     * turn, so the plan is derivable from `ctx` — and derived beats declared here, because a
     * `file_task` that silently omits `plan_id` produces a task the board can see but the project
     * cannot: the graph is orphaned, the project page reads empty, and `setState('running')` then
     * refuses the plan for having no tasks. An explicit `plan_id` still wins, so an operator-driven
     * or cross-project call is unaffected.
     */
    const planId = async (): Promise<string | null> => {
      const given = str('plan_id');
      if (given) return given;
      if (!ctx.sessionId) return null;
      const managing = await forumPlanRepository.findByManagerSession(ctx.sessionId);
      return managing ? String(managing._id) : null;
    };

    try {
      switch (action) {
        case 'my_tasks': {
          if (!ctx.agentId) return { result: { ok: false, error: 'no agent identity on this run' } };
          const { owned, reviewing } = await forumTaskRepository.listForAgent(ctx.agentId);
          return {
            result: {
              ok: true,
              yours: owned.map((t) => ({
                task_id: String(t._id),
                goal: t.goal,
                state: t.state,
                blocked_on: t.blocked_on || undefined,
                thread_id: String(t.thread_id),
              })),
              to_review: reviewing.map((t) => ({
                task_id: String(t._id),
                goal: t.goal,
                submitted: t.deliverable ? `${t.deliverable.kind} ${t.deliverable.ref}` : null,
              })),
              note:
                owned.length || reviewing.length
                  ? 'The board dispatches these to you when they are ready — you do not need to start them here.'
                  : 'Nothing is on you right now.',
            },
          };
        }

        case 'read_task': {
          const detail = await forumTaskService.detail(str('task_id'));
          if (!detail) return { result: { ok: false, error: `no such task: "${str('task_id')}"` } };
          return { result: { ok: true, task: detail } };
        }

        /**
         * The write that makes `done` mean something. It moves the task to `review`, never to
         * `done` — an agent does not sign off its own work, which is the single rule that separates
         * this from the `work_state` label it replaces.
         */
        case 'submit': {
          const d = (args.deliverable ?? {}) as Record<string, unknown>;
          const task = await forumTaskService.submit({
            taskId: str('task_id'),
            deliverable: { kind: String(d.kind ?? ''), ref: String(d.ref ?? ''), note: String(d.note ?? '') },
            actor,
          });
          const reviewer = task.reviewer?.display_name ?? 'the operator';
          log.info({ taskId: str('task_id'), agent: ctx.agentName }, 'task submitted');
          return {
            result: {
              ok: true,
              state: task.state,
              note:
                `Submitted. ${reviewer} reviews it next — the board dispatches them, so there is ` +
                'nothing else for you to do and nobody to tell. Your turn can end here.',
            },
          };
        }

        case 'block': {
          const task = await forumTaskService.block({ taskId: str('task_id'), reason: str('reason'), actor });
          return {
            result: {
              ok: true,
              state: task.state,
              note:
                "Parked, and the project's manager is shown your reason on its next pass. Do not " +
                'post about it or name anybody — your turn can end here.',
            },
          };
        }

        case 'review': {
          const verdict = str('verdict') === 'fail' ? 'fail' : 'pass';
          const task = await forumTaskService.review({
            taskId: str('task_id'),
            verdict,
            reasons: str('reasons'),
            actor,
          });
          return {
            result: {
              ok: true,
              state: task.state,
              note:
                verdict === 'pass'
                  ? 'Accepted. Anything waiting on this task is dispatched by the board itself.'
                  : `Sent back${task.state === 'blocked' ? " — and it has bounced enough times that the project's manager takes it from here" : ' to its owner, who is dispatched again from your reasons'}.`,
            },
          };
        }

        case 'file_task': {
          const { task, threadId } = await forumTaskService.fileTask({
            goal: str('goal'),
            acceptance: arr('acceptance'),
            owner: str('owner') || null,
            reviewer: str('reviewer') || null,
            dependsOn: arr('depends_on'),
            planId: await planId(),
            detail: str('detail'),
            author: actor,
            byAgent: true,
          });
          return {
            result: {
              ok: true,
              task_id: String(task._id),
              thread_id: threadId,
              note: 'Filed. Use this task_id in another task\'s depends_on to make it wait for this one.',
            },
          };
        }

        case 'patch_task': {
          const task = await forumTaskService.patch(str('task_id'), {
            ...(args.goal !== undefined ? { goal: str('goal') } : {}),
            ...(args.acceptance !== undefined ? { acceptance: arr('acceptance') } : {}),
            ...(args.owner !== undefined ? { owner: str('owner') } : {}),
            ...(args.reviewer !== undefined ? { reviewer: str('reviewer') } : {}),
            ...(args.depends_on !== undefined ? { dependsOn: arr('depends_on') } : {}),
            ...(args.state !== undefined ? { state: str('state') } : {}),
          });
          return { result: { ok: true, task: serialiseTask(task) } };
        }

        case 'list_plan': {
          const id = (await planId()) ?? '';
          const plan = await forumPlanRepository.findById(id);
          if (!plan) return { result: { ok: false, error: `no such project: "${id}"` } };
          const tasks = await forumTaskRepository.listByPlan(plan._id);
          return {
            result: {
              ok: true,
              plan: serialisePlan(plan),
              tasks: tasks.map((t) => ({
                task_id: String(t._id),
                goal: t.goal,
                state: t.state,
                owner: t.owner?.display_name ?? null,
                reviewer: t.reviewer?.display_name ?? null,
                depends_on: t.depends_on.map(String),
                blocked_on: t.blocked_on || undefined,
              })),
            },
          };
        }

        case 'finish_plan': {
          const plan = await forumPlanService.finish((await planId()) ?? '', actor);
          return { result: { ok: true, state: plan.state, note: 'Project closed.' } };
        }

        default:
          return { result: { ok: false, error: `unknown action: "${action}"` } };
      }
    } catch (err) {
      // A rule refusal is information the agent can act on inside this turn — a missing acceptance
      // criterion, a deliverable that is not there, a review with no reasons. Returned as a result
      // rather than thrown for exactly that reason: the model re-calls with the fix.
      if (err instanceof ForumRuleError) return { result: { ok: false, error: err.message } };
      log.error({ err: String(err), action }, 'board tool failed');
      return { result: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    }
  },
};
