import { createLogger } from '../../config/logger';
import { autoLoopRepository } from '../../domain/auto-loops/auto-loop.repository';
import type { Tool } from '../types';

const log = createLogger('tool:loop_done');

/**
 * `loop_done` — how a self-driving conversation ends (`AUTO_AGENT_PLAN.md` §4).
 *
 * Auto-granted by `AgentRunner`, but *only* when the running session actually has an active loop:
 * an ordinary chat never sees the tool, so it can't be called to "end" something that isn't running.
 *
 * It only writes the loop's status — it does not reach into the scheduler. That is what keeps the
 * tool layer free of a cycle back through `AutoLoopRunner` → `AgentRunner` → the registry, and it is
 * safe because a loop's next tick is armed *after* the turn completes: `AutoLoopRunner` re-reads the
 * doc before re-arming, sees `done`, and stops.
 */
export const loopDone: Tool = {
  name: 'loop_done',
  description:
    'End your auto loop: call this when the standing goal you were given has actually been achieved. ' +
    'This is the only thing that stops the loop from your side — if you finish the goal and do not ' +
    'call it, you will simply be woken again and asked to continue. Do not call it because a turn was ' +
    'hard, because you are blocked, or because you made good progress: report those in your reply and ' +
    'keep working. Only available while an auto loop is running.',
  parameters: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'What was achieved, in a few sentences — the operator reads this instead of the whole ' +
          'conversation. Say what was produced and where it lives.',
      },
    },
    required: ['summary'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (!summary) {
      return { result: { ok: false, error: '`summary` is required — say what the loop achieved.' } };
    }

    const loop = await autoLoopRepository.findBySession(ctx.sessionId);
    if (!loop || (loop.status !== 'running' && loop.status !== 'waiting')) {
      // Reachable if the operator stopped the loop mid-turn. Not an error worth a retry — say so
      // plainly so the agent finishes its reply instead of calling again.
      return { result: { ok: false, error: 'no auto loop is currently running on this conversation.' } };
    }

    await autoLoopRepository.setStatus(ctx.sessionId, 'done', {
      done_reason: summary,
      next_run_at: null,
    });
    log.info({ agent: ctx.agentName, session: ctx.sessionId, iteration: loop.iteration }, 'auto loop declared done');

    return {
      result: {
        ok: true,
        stopped: true,
        iterations: loop.iteration,
        message:
          'Auto loop ended. Finish this turn with your closing summary — you will not be woken again ' +
          'unless the operator starts a new loop.',
      },
    };
  },
};
