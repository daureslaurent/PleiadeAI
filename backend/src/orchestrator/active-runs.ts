import { eventBus } from '../core/event-bus/EventBus';
import type { AgentActivityPayload } from '../core/event-bus/events.types';

/**
 * Every agent run in flight, whoever started it — the operator's chat, a cron job, an auto-loop tick,
 * a forum wake, a flow node, Telegram, or another agent's `ask_agent`/`task`.
 *
 * `AgentRunner.run` is the one door all of them walk through, so it registers here and this is the
 * only place that can truthfully say "this agent is working". The browser used to count that itself,
 * from the chats it sent and the hops it happened to see in rooms it had joined — which is why an
 * agent woken by anything else sat in the Workspace with no pin at all.
 *
 * Each change emits the whole picture rather than a delta: a client that missed one (a reload, a
 * dropped socket) is simply correct again on the next, with no count to drift.
 */
interface ActiveRun {
  /** Null for a marker that only says a conversation is busy (see `markSession`). */
  agentName: string | null;
  sessionId: string;
}

const runs = new Map<symbol, ActiveRun>();

export const activeRuns = {
  /** Register a run; the returned function ends it (idempotent, so a `finally` can always call it). */
  begin(run: { agentName: string; sessionId: string }): () => void {
    return track(run);
  },

  /**
   * Mark a conversation busy whose run executes under another session — a flow's agent node runs under
   * the flow run's session but is recorded into a conversation of its own, which should shimmer too.
   * Counts no agent: the run itself already does.
   */
  markSession(sessionId: string): () => void {
    return track({ agentName: null, sessionId });
  },

  snapshot(): AgentActivityPayload {
    const agents: Record<string, number> = {};
    const sessions = new Set<string>();
    for (const { agentName, sessionId } of runs.values()) {
      if (agentName) agents[agentName] = (agents[agentName] ?? 0) + 1;
      sessions.add(sessionId);
    }
    return { agents, sessions: [...sessions] };
  },
};

function track(run: ActiveRun): () => void {
  const key = Symbol('run');
  runs.set(key, run);
  eventBus.emit('agent:activity', activeRuns.snapshot());
  return () => {
    if (!runs.delete(key)) return;
    eventBus.emit('agent:activity', activeRuns.snapshot());
  };
}
