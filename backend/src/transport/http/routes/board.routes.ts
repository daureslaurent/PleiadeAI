import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { ForumRuleError } from '../../../domain/forum/forum.service';
import { forumTaskRepository } from '../../../domain/forum/forum-task.repository';
import { forumPlanRepository } from '../../../domain/forum/forum-plan.repository';
import {
  forumTaskService,
  serialisePlan,
  serialiseTask,
} from '../../../domain/forum/forum-task.service';
import { forumPlanService } from '../../../domain/forum/forum-plan.service';
import { forumScheduler } from '../../../domain/forum/forum-scheduler';
import { OPERATOR_AUTHOR } from '../../../domain/forum/forum-author';
import { FORUM_PLAN_STATES } from '../../../domain/forum/forum-plan.model';
import type { ForumTaskDoc } from '../../../domain/forum/forum-task.model';
import { forumProposalRepository } from '../../../domain/forum/forum-proposal.repository';
import { forumProposalService, serialiseProposal } from '../../../domain/forum/forum-proposal.service';
import { boardAnalyseService } from '../../../domain/forum/board-analyse.service';
import { liveRuns } from '../../ws/live-runs';

/**
 * A task only the operator can move: stopped with a reason, or submitted with nobody but the operator
 * to sign it off. Mirrors `needsOperator` in the board page, so the list's badge and the page agree.
 */
function waitsOnOperator(t: ForumTaskDoc): boolean {
  return t.state === 'blocked' || (t.state === 'review' && (!t.reviewer || t.reviewer.kind === 'operator'));
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

const log = createLogger('http:board');

/**
 * The operator's side of the work board (spec `FORUM_WORKBOARD_PLAN.md`).
 *
 * Mounted at `/api/board` behind `requireAuth`, like every other router here. Everything written
 * through it is authored by **`Operator`** — the human is a member of the board, not a separate
 * kind of actor, which is the rule `forum.routes.ts` already establishes.
 *
 * The operator can do three things no agent can: start a drafted plan, force a task's state, and
 * dispatch a turn on demand. All three are deliberate — the manager is an LLM, so somebody has to
 * be able to read a plan before it runs and to unstick one that has gone wrong.
 */
export const boardRouter = Router();

function fail(res: Parameters<Parameters<typeof boardRouter.get>[1]>[1], err: unknown): void {
  if (err instanceof ForumRuleError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  log.error({ err: String(err) }, 'board route failed');
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

// --- plans -----------------------------------------------------------------

boardRouter.get('/plans', async (_req, res) => {
  const [plans, pending] = await Promise.all([forumPlanRepository.list(), forumProposalRepository.pendingPlanIds()]);
  const withCounts = await Promise.all(
    plans.map(async (plan) => {
      const tasks = await forumTaskRepository.listByPlan(plan._id);
      const pendingProposal = pending.has(String(plan._id));
      // A task item's card shows who has it, so it needs no second request either.
      const only = plan.kind === 'task' && tasks.length === 1 ? tasks[0] : null;
      return {
        ...serialisePlan(plan),
        taskCount: tasks.length,
        doneCount: tasks.filter((t) => t.state === 'done').length,
        blockedCount: tasks.filter((t) => t.state === 'blocked').length,
        reviewCount: tasks.filter((t) => t.state === 'review').length,
        doingCount: tasks.filter((t) => t.state === 'doing').length,
        pendingProposal,
        needsYou: pendingProposal || plan.state === 'blocked' || tasks.some(waitsOnOperator),
        task: only ? { state: only.state, owner: only.owner, reviewer: only.reviewer, inFlight: Boolean(only.dispatch?.session_id) } : null,
      };
    }),
  );
  res.json(withCounts);
});

/** Fill the create form from a prompt (`BOARD_REFACTOR_PLAN.md` §2). Suggestions only — nothing is created. */
boardRouter.post('/analyse', async (req, res) => {
  try {
    const kind = req.body?.kind === 'task' || req.body?.kind === 'project' ? req.body.kind : undefined;
    res.json(
      await boardAnalyseService.analyse({
        prompt: String(req.body?.prompt ?? ''),
        agentId: String(req.body?.agentId ?? ''),
        kind,
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});

boardRouter.get('/plans/:id', async (req, res) => {
  const plan = await forumPlanRepository.findById(req.params.id);
  if (!plan) {
    res.status(404).json({ error: 'no such project' });
    return;
  }
  // Plans from before the refactor get their PM conversation the first time they are opened.
  const withChat = await forumPlanService.ensureChatSession(plan).catch(() => plan);
  const [tasks, proposal] = await Promise.all([
    forumTaskRepository.listByPlan(plan._id),
    forumProposalRepository.latest(plan._id),
  ]);
  res.json({
    ...serialisePlan(withChat),
    tasks: tasks.map(serialiseTask),
    pendingProposal: proposal?.state === 'pending',
    // Whether the manager is mid-turn in its conversation, so the page can show the chat as busy.
    managerRunning: Boolean(withChat.chat_session_id && liveRuns.has(String(withChat.chat_session_id))),
  });
});

boardRouter.get('/plans/:id/proposals', async (req, res) => {
  const proposals = await forumProposalRepository.listByPlan(req.params.id);
  res.json(proposals.map(serialiseProposal));
});

boardRouter.get('/proposals/:id', async (req, res) => {
  const proposal = await forumProposalRepository.findById(req.params.id);
  if (!proposal) {
    res.status(404).json({ error: 'no such proposal' });
    return;
  }
  res.json(serialiseProposal(proposal));
});

/** Apply the ticked lines of a proposal (all of them when `opIds` is absent). */
boardRouter.post('/proposals/:id/apply', async (req, res) => {
  try {
    const opIds = Array.isArray(req.body?.opIds) ? req.body.opIds.map(String) : null;
    res.json(serialiseProposal(await forumProposalService.apply(req.params.id, opIds)));
  } catch (err) {
    fail(res, err);
  }
});

boardRouter.post('/proposals/:id/reject', async (req, res) => {
  try {
    res.json(serialiseProposal(await forumProposalService.reject(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

boardRouter.post('/plans', async (req, res) => {
  try {
    const plan = await forumPlanService.create({
      goal: String(req.body?.goal ?? ''),
      kind: req.body?.kind === 'task' ? 'task' : 'project',
      name: req.body?.name ? String(req.body.name) : undefined,
      description: req.body?.description ? String(req.body.description) : undefined,
      acceptance: strList(req.body?.acceptance),
      managerAgentId: req.body?.managerAgentId ? String(req.body.managerAgentId) : null,
      owner: req.body?.owner ? String(req.body.owner) : null,
      reviewer: req.body?.reviewer ? String(req.body.reviewer) : null,
      category: req.body?.category ? String(req.body.category) : undefined,
      turnsMax: req.body?.turnsMax ? Number(req.body.turnsMax) : undefined,
      author: OPERATOR_AUTHOR,
    });
    res.status(201).json(serialisePlan(plan));
  } catch (err) {
    fail(res, err);
  }
});

/** Send the manager in to write (or rewrite) the graph. Returns the session so the operator can watch. */
boardRouter.post('/plans/:id/plan', async (req, res) => {
  try {
    const started = await forumPlanService.runManager(req.params.id, String(req.body?.escalation ?? ''));
    if (!started) {
      res.status(409).json({
        error: 'the manager is already busy on this item (planning, or in a chat turn), or it is out of turns',
      });
      return;
    }
    res.status(202).json(started);
  } catch (err) {
    fail(res, err);
  }
});

boardRouter.patch('/plans/:id', async (req, res) => {
  try {
    if (typeof req.body?.state === 'string') {
      if (!(FORUM_PLAN_STATES as readonly string[]).includes(req.body.state)) {
        res.status(400).json({ error: `state must be one of: ${FORUM_PLAN_STATES.join(', ')}` });
        return;
      }
      const plan = await forumPlanService.setState(req.params.id, req.body.state);
      res.json(serialisePlan(plan));
      return;
    }
    const patch: Record<string, unknown> = {};
    if (req.body?.goal) patch.goal = String(req.body.goal);
    if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim();
    if (typeof req.body?.description === 'string') patch.description = req.body.description.trim();
    if (Array.isArray(req.body?.acceptance)) patch.acceptance = strList(req.body.acceptance);
    if (req.body?.turnsMax) patch.turns_max = Math.max(1, Number(req.body.turnsMax));
    // Subagent mode, per project. Empty strings are meaningful here — they clear the project's
    // override and hand it back to the fleet setting — so these test for presence, not truthiness.
    if (typeof req.body?.subagentEndpointId === 'string') {
      patch.subagent_endpoint_id = req.body.subagentEndpointId.trim();
    }
    if (typeof req.body?.subagentModel === 'string') {
      patch.subagent_model = req.body.subagentModel.trim();
    }
    const plan = await forumPlanRepository.update(req.params.id, patch);
    if (!plan) {
      res.status(404).json({ error: 'no such project' });
      return;
    }
    res.json(serialisePlan(plan));
  } catch (err) {
    fail(res, err);
  }
});

boardRouter.delete('/plans/:id', async (req, res) => {
  const ok = await forumPlanRepository.remove(req.params.id);
  if (ok) await forumProposalRepository.removeByPlan(req.params.id);
  res.status(ok ? 204 : 404).end();
});

// --- tasks -----------------------------------------------------------------

boardRouter.get('/tasks', async (req, res) => {
  const planId = typeof req.query.plan === 'string' ? req.query.plan : '';
  const tasks = planId ? await forumTaskRepository.listByPlan(planId) : await forumTaskRepository.listOpen();
  res.json(tasks.map(serialiseTask));
});

/**
 * The task attached to a forum thread, if it has one.
 *
 * The thread page needs this to show what the discussion is *about* — a task's thread reads as an
 * ordinary thread otherwise, which is precisely the ambiguity `work_state` created. Answers 204
 * rather than 404 for a thread that is simply not a task, because that is the common case and not
 * an error.
 */
boardRouter.get('/tasks/by-thread/:threadId', async (req, res) => {
  const task = await forumTaskRepository.findByThread(req.params.threadId);
  if (!task) {
    res.status(204).end();
    return;
  }
  res.json(serialiseTask(task));
});

boardRouter.get('/tasks/:id', async (req, res) => {
  const detail = await forumTaskService.detail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: 'no such task' });
    return;
  }
  res.json(detail);
});

boardRouter.post('/tasks', async (req, res) => {
  try {
    const { task, threadId } = await forumTaskService.fileTask({
      goal: String(req.body?.goal ?? ''),
      acceptance: Array.isArray(req.body?.acceptance) ? req.body.acceptance.map(String) : [],
      owner: req.body?.owner ? String(req.body.owner) : null,
      reviewer: req.body?.reviewer ? String(req.body.reviewer) : null,
      dependsOn: Array.isArray(req.body?.dependsOn) ? req.body.dependsOn.map(String) : [],
      planId: req.body?.planId ? String(req.body.planId) : null,
      category: req.body?.category ? String(req.body.category) : undefined,
      detail: req.body?.detail ? String(req.body.detail) : undefined,
      author: OPERATOR_AUTHOR,
      byAgent: false,
    });
    res.status(201).json({ ...serialiseTask(task), threadId });
  } catch (err) {
    fail(res, err);
  }
});

boardRouter.patch('/tasks/:id', async (req, res) => {
  try {
    res.json(serialiseTask(await forumTaskService.patch(req.params.id, req.body ?? {})));
  } catch (err) {
    fail(res, err);
  }
});

/**
 * The operator's verdict on a submitted task — the same call the reviewer agent makes.
 *
 * It exists because `reviewerFor` falls back to the operator for a standalone task and for one whose
 * owner is the plan's manager: without this route, those tasks would reach `review` and stop there
 * forever.
 */
boardRouter.post('/tasks/:id/review', async (req, res) => {
  try {
    const task = await forumTaskService.review({
      taskId: req.params.id,
      verdict: req.body?.verdict === 'fail' ? 'fail' : 'pass',
      reasons: req.body?.reasons ? String(req.body.reasons) : undefined,
      actor: OPERATOR_AUTHOR,
    });
    res.json(serialiseTask(task));
  } catch (err) {
    fail(res, err);
  }
});

/**
 * "Stop holding this" — force an in-flight claim off, aborting the run if one is still going.
 *
 * The counterpart of Run now, and the only way out of a claim whose run ended without saying so: the
 * reaper gets there on its own, but on a tick and after a grace window, and until it does the task
 * reads as `doing` with no turn behind it and no button on it.
 */
boardRouter.post('/tasks/:id/release', async (req, res) => {
  try {
    res.json(serialiseTask(await forumTaskService.release(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

/** "Run this one now" — the manual counterpart of a tick, for a task the operator does not want to wait on. */
boardRouter.post('/tasks/:id/dispatch', async (req, res) => {
  try {
    const kind = req.body?.kind === 'review' ? 'review' : 'work';
    const started = await forumScheduler.dispatchNow(req.params.id, kind);
    if (!started) {
      res.status(409).json({ error: 'nothing to dispatch — no owner, already running, or out of turns' });
      return;
    }
    res.status(202).json(started);
  } catch (err) {
    fail(res, err);
  }
});

boardRouter.delete('/tasks/:id', async (req, res) => {
  const ok = await forumTaskRepository.remove(req.params.id);
  res.status(ok ? 204 : 404).end();
});
