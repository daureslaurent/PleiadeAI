import { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { ForumRuleError } from './forum.service';
import { forumPlanRepository } from './forum-plan.repository';
import { forumTaskRepository } from './forum-task.repository';
import { forumTaskService } from './forum-task.service';
import { forumProposalRepository } from './forum-proposal.repository';
import { loadRoster } from './forum-roster';
import { describeOp } from './forum-project-context';
import {
  FORUM_PROPOSAL_OPS,
  type ForumProposalDoc,
  type ForumProposalOpKind,
  type ForumProposalState,
} from './forum-proposal.model';

const log = createLogger('forum-proposal');

/** One change as the manager wrote it. Fields may sit at the top level or under `args`. */
type RawChange = Record<string, unknown>;

interface ValidOp {
  op_id: string;
  op: ForumProposalOpKind;
  ref: string;
  task_id: string;
  args: Record<string, unknown>;
  why: string;
}

const TASK_FIELDS = ['goal', 'acceptance', 'owner', 'reviewer', 'depends_on'] as const;
const PLAN_FIELDS = ['name', 'description', 'acceptance'] as const;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

/**
 * Check a proposal against the board *before* the operator sees it (`BOARD_REFACTOR_PLAN.md` §6).
 *
 * Every rule `fileTask` and `patch` would enforce at apply time is enforced here too, and refused
 * back to the manager inside its turn. A proposal that only fails once the operator presses Apply
 * has cost the operator a read and the manager a second turn; one refused now costs a retried call.
 * Apply still re-checks, because the board can move between proposing and applying.
 */
async function validate(planId: string, changes: RawChange[]): Promise<ValidOp[]> {
  if (!changes.length) throw new ForumRuleError('a proposal needs at least one change in `changes`', 400);
  const tasks = await forumTaskRepository.listByPlan(planId);
  const byId = new Map(tasks.map((t) => [String(t._id), t]));
  const roster = await loadRoster();

  const agent = (name: unknown, label: string, i: number): string => {
    const wanted = String(name ?? '').trim();
    if (!wanted) return '';
    const hit = roster.byName.get(wanted.toLowerCase());
    if (!hit || (hit.kind !== 'agent' && label === 'owner')) {
      const known = [...roster.byName.values()].filter((r) => r.kind === 'agent').map((r) => r.name);
      throw new ForumRuleError(`change ${i + 1}: no agent called "${wanted}" for ${label}. Known agents: ${known.join(', ')}`, 400);
    }
    return hit.name;
  };

  const refs = new Set<string>();
  const ops: ValidOp[] = [];

  changes.forEach((raw, i) => {
    const c: RawChange = { ...((raw.args as RawChange) ?? {}), ...raw };
    const op = String(c.op ?? c.type ?? '').trim() as ForumProposalOpKind;
    if (!FORUM_PROPOSAL_OPS.includes(op)) {
      throw new ForumRuleError(`change ${i + 1}: \`op\` must be one of ${FORUM_PROPOSAL_OPS.join(', ')}`, 400);
    }
    const why = String(c.why ?? '').trim();
    const taskId = String(c.task_id ?? '').trim();
    const deps = (): string[] => {
      const list = strings(c.depends_on);
      for (const d of list) {
        if (!byId.has(d) && !refs.has(d)) {
          throw new ForumRuleError(
            `change ${i + 1}: depends_on "${d}" is neither a task of this item nor the ref of an earlier add_task`,
            400,
          );
        }
      }
      return list;
    };
    const existing = (): void => {
      const t = byId.get(taskId);
      if (!t) throw new ForumRuleError(`change ${i + 1}: "${taskId}" is not a task of this item`, 400);
      if (t.state === 'done' || t.state === 'cancelled') {
        throw new ForumRuleError(`change ${i + 1}: task "${taskId}" is already ${t.state}`, 409);
      }
    };

    if (op === 'add_task') {
      const goal = String(c.goal ?? '').trim();
      const acceptance = strings(c.acceptance);
      if (!goal) throw new ForumRuleError(`change ${i + 1}: add_task needs a \`goal\``, 400);
      if (!acceptance.length) {
        throw new ForumRuleError(`change ${i + 1}: add_task needs \`acceptance\` — criteria a different agent could check`, 400);
      }
      const owner = agent(c.owner, 'owner', i);
      const reviewer = agent(c.reviewer, 'reviewer', i);
      if (owner && reviewer && owner.toLowerCase() === reviewer.toLowerCase()) {
        throw new ForumRuleError(`change ${i + 1}: the reviewer cannot be the owner`, 400);
      }
      const dependsOn = deps();
      const ref = String(c.ref ?? '').trim() || `new${i + 1}`;
      if (refs.has(ref) || byId.has(ref)) throw new ForumRuleError(`change ${i + 1}: ref "${ref}" is used twice`, 400);
      refs.add(ref);
      ops.push({ op_id: `op${i + 1}`, op, ref, task_id: '', why, args: { goal, acceptance, owner, reviewer, depends_on: dependsOn } });
      return;
    }

    if (op === 'patch_task') {
      existing();
      const args: Record<string, unknown> = {};
      for (const f of TASK_FIELDS) {
        if (c[f] === undefined) continue;
        if (f === 'acceptance') args.acceptance = strings(c.acceptance);
        else if (f === 'depends_on') args.depends_on = deps();
        else if (f === 'owner' || f === 'reviewer') args[f] = agent(c[f], f, i);
        else args[f] = String(c[f]).trim();
      }
      if (!Object.keys(args).length) {
        throw new ForumRuleError(`change ${i + 1}: patch_task changes nothing — give the fields that change`, 400);
      }
      if (Array.isArray(args.acceptance) && !args.acceptance.length) {
        throw new ForumRuleError(`change ${i + 1}: a task cannot be left with no acceptance criteria`, 400);
      }
      ops.push({ op_id: `op${i + 1}`, op, ref: '', task_id: taskId, why, args });
      return;
    }

    if (op === 'cancel_task') {
      existing();
      ops.push({ op_id: `op${i + 1}`, op, ref: '', task_id: taskId, why, args: {} });
      return;
    }

    const args: Record<string, unknown> = {};
    for (const f of PLAN_FIELDS) {
      if (c[f] === undefined) continue;
      args[f] = f === 'acceptance' ? strings(c.acceptance) : String(c[f]).trim();
    }
    if (!Object.keys(args).length) {
      throw new ForumRuleError(`change ${i + 1}: patch_plan changes nothing — give name, description or acceptance`, 400);
    }
    ops.push({ op_id: `op${i + 1}`, op, ref: '', task_id: '', why, args });
  });

  return ops;
}

export const forumProposalService = {
  /** The manager's `board` `propose`, from a chat turn. Supersedes any proposal still pending. */
  async propose(input: {
    planId: string;
    summary: string;
    changes: RawChange[];
    sessionId: string;
  }): Promise<ForumProposalDoc> {
    const plan = await forumPlanRepository.findById(input.planId);
    if (!plan) throw new ForumRuleError(`no such item: "${input.planId}"`, 404);
    const ops = await validate(String(plan._id), input.changes);
    const proposal = await forumProposalRepository.create({
      plan_id: plan._id,
      session_id: Types.ObjectId.isValid(input.sessionId) ? new Types.ObjectId(input.sessionId) : null,
      summary: input.summary.trim() || ops.map(describeOp).join('; '),
      ops,
    });
    log.info({ planId: input.planId, proposalId: String(proposal._id), ops: ops.length }, 'proposal filed');
    return proposal;
  },

  /**
   * Apply the ticked lines of a proposal, in the order the manager wrote them.
   *
   * Each op runs through the same service call the tool and the routes use, so the board's rules are
   * enforced once. An `add_task` gets its real id as it lands, and a later op naming its ref is
   * rewritten to it — or fails, if that task was left out or itself failed, rather than being filed
   * waiting on nothing.
   */
  async apply(proposalId: string, opIds: string[] | null): Promise<ForumProposalDoc> {
    const proposal = await forumProposalRepository.findById(proposalId);
    if (!proposal) throw new ForumRuleError('no such proposal', 404);
    if (proposal.state !== 'pending') throw new ForumRuleError(`this proposal is already ${proposal.state}`, 409);
    const plan = await forumPlanRepository.findById(proposal.plan_id);
    if (!plan) throw new ForumRuleError('the item this proposal belongs to is gone', 404);

    const selected = opIds ? new Set(opIds) : null;
    const refMap = new Map<string, string>();
    const proposalRefs = new Set(proposal.ops.filter((o) => o.op === 'add_task' && o.ref).map((o) => o.ref));
    let addedTask = false;

    for (const op of proposal.ops) {
      if (op.status !== 'pending') continue;
      if (selected && !selected.has(op.op_id)) {
        op.status = 'rejected';
        continue;
      }
      const args = (op.args ?? {}) as Record<string, unknown>;
      try {
        const mapDeps = (list: unknown): string[] =>
          strings(list).map((d) => {
            const id = refMap.get(d);
            if (id) return id;
            if (proposalRefs.has(d)) throw new ForumRuleError(`it waits on "${d}", which was not applied`, 409);
            return d;
          });

        switch (op.op) {
          case 'add_task': {
            const { task } = await forumTaskService.fileTask({
              goal: String(args.goal ?? ''),
              acceptance: strings(args.acceptance),
              owner: String(args.owner ?? '') || null,
              reviewer: String(args.reviewer ?? '') || null,
              dependsOn: mapDeps(args.depends_on),
              planId: String(plan._id),
              author: plan.manager,
              byAgent: true,
            });
            op.task_id = String(task._id);
            if (op.ref) refMap.set(op.ref, op.task_id);
            addedTask = true;
            break;
          }
          case 'patch_task': {
            const body: Record<string, unknown> = {};
            if (args.goal !== undefined) body.goal = args.goal;
            if (args.acceptance !== undefined) body.acceptance = args.acceptance;
            if (args.owner !== undefined) body.owner = args.owner;
            if (args.reviewer !== undefined) body.reviewer = args.reviewer;
            if (args.depends_on !== undefined) body.dependsOn = mapDeps(args.depends_on);
            await forumTaskService.patch(op.task_id, body);
            break;
          }
          case 'cancel_task':
            await forumTaskService.patch(op.task_id, { state: 'cancelled' });
            break;
          case 'patch_plan':
            await forumPlanRepository.update(plan._id, args);
            break;
        }
        op.status = 'applied';
        op.error = '';
      } catch (err) {
        op.status = 'failed';
        op.error = err instanceof Error ? err.message : String(err);
      }
    }

    // New work on a finished item reopens it as a draft: the operator presses Start again, rather
    // than a closed project quietly starting to dispatch.
    if (addedTask && (plan.state === 'done' || plan.state === 'cancelled')) {
      await forumPlanRepository.update(plan._id, { state: 'draft', finished_at: null });
    }

    const statuses = proposal.ops.map((o) => o.status);
    const state: ForumProposalState = statuses.every((s) => s === 'applied')
      ? 'applied'
      : statuses.some((s) => s === 'applied')
        ? 'partial'
        : 'rejected';
    proposal.state = state;
    proposal.decided_at = new Date();
    const saved = await forumProposalRepository.save(proposal);
    log.info({ proposalId, state, by: 'operator' }, 'proposal decided');
    return saved;
  },

  async reject(proposalId: string): Promise<ForumProposalDoc> {
    const proposal = await forumProposalRepository.findById(proposalId);
    if (!proposal) throw new ForumRuleError('no such proposal', 404);
    if (proposal.state !== 'pending') throw new ForumRuleError(`this proposal is already ${proposal.state}`, 409);
    for (const op of proposal.ops) if (op.status === 'pending') op.status = 'rejected';
    proposal.state = 'rejected';
    proposal.decided_at = new Date();
    return forumProposalRepository.save(proposal);
  },
};

/** One shape for a proposal on the wire. */
export function serialiseProposal(p: ForumProposalDoc): Record<string, unknown> {
  return {
    id: String(p._id),
    planId: String(p.plan_id),
    sessionId: p.session_id ? String(p.session_id) : null,
    summary: p.summary,
    state: p.state,
    createdAt: p.created_at,
    decidedAt: p.decided_at,
    ops: p.ops.map((o) => ({
      opId: o.op_id,
      op: o.op,
      ref: o.ref,
      taskId: o.task_id,
      args: o.args,
      why: o.why,
      status: o.status,
      error: o.error,
    })),
  };
}
