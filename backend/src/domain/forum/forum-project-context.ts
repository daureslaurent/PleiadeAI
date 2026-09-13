import { forumPlanRepository } from './forum-plan.repository';
import { forumTaskRepository } from './forum-task.repository';
import { forumProposalRepository } from './forum-proposal.repository';

/**
 * Which board run this is (`BOARD_REFACTOR_PLAN.md` §5).
 *
 * `auto` is a turn the board started — the first plan, a replan on escalation — and writes the graph
 * directly, as manager turns always have. `chat` is the operator typing into the item's PM
 * conversation, and may only *propose*. Set by the backend alone (`forum-plan.service.ts`,
 * `socket.ts`), never taken from a client, because it is what decides whether a turn can write.
 */
export interface BoardRunContext {
  planId: string;
  mode: 'auto' | 'chat';
}

/** What the manager is shown of its own item, every turn. Rendered by the board module. */
export interface BoardProjectPromptState {
  mode: 'auto' | 'chat';
  plan: {
    id: string;
    kind: string;
    name: string;
    description: string;
    goal: string;
    state: string;
    acceptance: string[];
    turnsSpent: number;
    turnsMax: number;
    escalation: string;
  };
  tasks: Array<{
    id: string;
    goal: string;
    state: string;
    owner: string | null;
    reviewer: string | null;
    dependsOn: string[];
    blockedOn: string;
    delivered: boolean;
    reviewRounds: number;
  }>;
  /** The latest proposal and what the operator did with each line of it. */
  proposal: {
    id: string;
    state: string;
    summary: string;
    ops: Array<{ op: string; label: string; status: string; error: string }>;
  } | null;
}

/** One line naming what an op does, for the prompt and for logs. */
export function describeOp(op: { op: string; ref?: string; task_id?: string; args?: unknown }): string {
  const a = (op.args ?? {}) as Record<string, unknown>;
  switch (op.op) {
    case 'add_task':
      return `add task${op.ref ? ` ${op.ref}` : ''}: ${String(a.goal ?? '')}`;
    case 'patch_task':
      return `edit task ${op.task_id}: ${Object.keys(a).join(', ')}`;
    case 'cancel_task':
      return `cancel task ${op.task_id}`;
    case 'patch_plan':
      return `edit item: ${Object.keys(a).join(', ')}`;
    default:
      return op.op;
  }
}

export async function loadProjectSnapshot(run: BoardRunContext): Promise<BoardProjectPromptState | null> {
  const plan = await forumPlanRepository.findById(run.planId);
  if (!plan) return null;
  const [tasks, proposal] = await Promise.all([
    forumTaskRepository.listByPlan(plan._id),
    forumProposalRepository.latest(plan._id),
  ]);
  return {
    mode: run.mode,
    plan: {
      id: String(plan._id),
      kind: plan.kind ?? 'project',
      name: plan.name || plan.goal,
      description: plan.description ?? '',
      goal: plan.goal,
      state: plan.state,
      acceptance: plan.acceptance ?? [],
      turnsSpent: plan.turns_spent,
      turnsMax: plan.turns_max,
      escalation: plan.escalation ?? '',
    },
    tasks: tasks.map((t) => ({
      id: String(t._id),
      goal: t.goal,
      state: t.state,
      owner: t.owner?.display_name ?? null,
      reviewer: t.reviewer?.display_name ?? null,
      dependsOn: t.depends_on.map(String),
      blockedOn: t.blocked_on ?? '',
      delivered: Boolean(t.deliverable),
      reviewRounds: t.review_rounds,
    })),
    proposal: proposal
      ? {
          id: String(proposal._id),
          state: proposal.state,
          summary: proposal.summary,
          ops: proposal.ops.map((o) => ({
            op: o.op,
            label: describeOp(o),
            status: o.status,
            error: o.error ?? '',
          })),
        }
      : null,
  };
}
