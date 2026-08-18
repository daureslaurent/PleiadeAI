import { createLogger } from '../config/logger';
import { eventBus } from '../core/event-bus/EventBus';
import type { EventContext } from '../core/event-bus/events.types';
import { sessionLock } from '../core/session/SessionLock';
import { agentRunner } from '../orchestrator/AgentRunner';
import { autoLoopRepository } from '../domain/auto-loops/auto-loop.repository';
import type { AutoLoopDoc } from '../domain/auto-loops/auto-loop.model';
import { sessionRepository } from '../domain/sessions/session.repository';
import type { ChatMessage } from '../domain/agents/jit-builder';
import { liveRuns } from '../transport/ws/live-runs';
import { TurnRecorder } from '../transport/ws/TurnRecorder';

const log = createLogger('auto-loop');

/**
 * Consecutive failed turns before the loop parks itself in `error`.
 *
 * Not a limit on the loop's length — the operator chose "runs until the agent says it's done" — but a
 * breaker on a loop that cannot run at all. A dead endpoint or a deleted agent would otherwise have
 * the scheduler firing a failing turn every interval forever, filling the conversation with identical
 * stack traces and burning the inference host. Same reasoning as the skill sandbox's breaker.
 */
const MAX_CONSECUTIVE_ERRORS = 5;

/** How long a tick waits for a live operator chat on the same agent before giving up its slot. */
const YIELD_TIMEOUT_MS = 2 * 60_000;

/** Floor on the interval, so a mistyped `0` can't turn into an unthrottled inference hammer. */
const MIN_INTERVAL_SEC = 10;

/** How much of the agent's answer becomes the iteration's recap line in the next prompt. */
const SUMMARY_CHARS = 400;

/**
 * How many past messages of the conversation are replayed as history. A loop is one *growing*
 * conversation, so unlike a cron run its history is unbounded by construction — this is the cap that
 * keeps iteration 200 from trying to send 200 turns. The goal and the progress recap are what carry
 * continuity past this window, which is exactly why they are re-injected every turn.
 */
const MAX_HISTORY_MESSAGES = 30;

/**
 * The auto-agent scheduler (`AUTO_AGENT_PLAN.md` §4).
 *
 * One timer per active loop, keyed by session id. The interval is measured from the *end* of a turn,
 * not on a wall clock: a turn that runs longer than its own interval therefore simply delays the next
 * one instead of overlapping itself, which removes the entire class of "tick fired while still
 * streaming" races without needing a lock.
 *
 * Timers live in this process and the durable state lives in Mongo, so `resume()` at boot re-arms
 * everything that was mid-flight. A loop interrupted by a restart loses at most its in-flight turn.
 */
class AutoLoopRunner {
  private timers = new Map<string, NodeJS.Timeout>();

  /** Re-arm every loop that was running when the process went down. Called once at boot. */
  async resume(): Promise<void> {
    const loops = await autoLoopRepository.listActive();
    for (const loop of loops) {
      // A loop caught mid-turn by the restart is re-armed like any other: its interrupted turn was
      // never persisted, so the next tick simply re-sends the continue message.
      this.schedule(loop.session_id, loop.interval_sec);
      log.info({ session: loop.session_id, agent: loop.agent_name }, 'auto loop resumed');
    }
    if (loops.length) log.info({ count: loops.length }, 'auto loops resumed after restart');
  }

  /**
   * Arm (or re-arm) a loop and fire the first tick immediately — the operator clicked start, and a
   * loop that sat silent for its first full interval reads as a broken button.
   */
  async start(loop: AutoLoopDoc): Promise<AutoLoopDoc> {
    this.clearTimer(loop.session_id);
    this.emitState(loop);
    this.schedule(loop.session_id, 0);
    return loop;
  }

  /** Operator stop. Terminal: restarting means starting a new loop. */
  async stop(sessionId: string): Promise<AutoLoopDoc | null> {
    this.clearTimer(sessionId);
    const loop = await autoLoopRepository.setStatus(sessionId, 'stopped', { next_run_at: null });
    if (loop) this.emitState(loop);
    return loop;
  }

  /** Drop a loop's timer without touching its document (the session itself is going away). */
  forget(sessionId: string): void {
    this.clearTimer(sessionId);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private schedule(sessionId: string, delaySec: number): void {
    this.clearTimer(sessionId);
    const ms = Math.max(0, delaySec) * 1000;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.tick(sessionId).catch((err) =>
        log.error({ err: String(err), session: sessionId }, 'auto loop tick crashed'),
      );
    }, ms);
    // Don't hold the event loop open for a countdown — a shutdown shouldn't wait out an interval.
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  /**
   * One iteration: yield to the operator, send the turn, persist it, recap it, re-arm.
   *
   * Every exit path re-reads the loop document before deciding what to do next, because the agent
   * may have called `loop_done` *during* the turn we just ran (the tool writes status and nothing
   * else — see `tools/core/loopDone.ts`), and the operator may have hit stop.
   */
  private async tick(sessionId: string): Promise<void> {
    const loop = await autoLoopRepository.findBySession(sessionId);
    if (!loop) return;
    if (loop.status !== 'waiting' && loop.status !== 'running') return;

    const agentId = String(loop.agent_id);

    // A live operator chat with this agent wins, exactly as a cron job yields to one. Unlike the
    // cron job we don't re-queue on a separate schedule — the loop already has one, so it just waits
    // out another interval.
    const free = await sessionLock.waitUntilFree(agentId, YIELD_TIMEOUT_MS);
    if (!free) {
      log.info({ session: sessionId, agent: loop.agent_name }, 'agent busy; deferring auto loop tick');
      await this.rearm(sessionId, loop.interval_sec);
      return;
    }

    const iteration = loop.iteration + 1;
    // Iteration 1 sends the kickoff text; every later one sends the continue message. Either may be
    // blank in the form, so both fall back to something that still reads as an instruction.
    const userText =
      iteration === 1
        ? loop.seed.trim() || loop.goal.trim() || 'Begin working on your goal.'
        : loop.continue_text.trim() || 'Continue working toward your goal.';

    const running = await autoLoopRepository.setStatus(sessionId, 'running', { next_run_at: null });
    if (running) this.emitState(running);

    const ctx: EventContext = { sessionId, agentId, agentName: loop.agent_name, depth: 0 };
    const tickStartedAt = new Date();

    // Show the injected turn to anyone watching the conversation, and persist it — a loop turn is an
    // ordinary session message, which is the whole point of a loop being a session.
    await sessionRepository.addMessage(sessionId, { role: 'user', text: userText });
    eventBus.emit('chat:user_message', { ctx, content: userText });

    // Mirror the run off the EventBus the way the socket layer does for a client that left: nobody
    // may be watching, and the rich blocks (tool calls, sub-agent hops) are most of what the operator
    // will want to read when they come back to it hours later.
    const recorder = new TurnRecorder(sessionId, loop.agent_name);
    recorder.start();
    const controller = new AbortController();
    // Registering the controller is what makes the Workspace's stop button work on a loop turn: it
    // aborts the run in flight, and the turn settles through the normal path.
    liveRuns.start(sessionId, recorder, controller);

    sessionLock.acquireUserSession(agentId);
    try {
      const history = await this.loadHistory(sessionId);
      const result = await agentRunner.run({
        agentName: loop.agent_name,
        sessionId,
        depth: 0,
        userText,
        history,
        signal: controller.signal,
        autoLoop: {
          goal: loop.goal,
          iteration,
          intervalSec: loop.interval_sec,
          progress: loop.progress.map((p) => ({ n: p.n, summary: p.summary })),
          forumSeenAt: loop.forum_seen_at ?? loop.started_at ?? tickStartedAt,
        },
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
      // `persisted: true` — a watching client renders the finished turn but must not save it again.
      eventBus.emit('conversation:turn_complete', {
        ctx,
        answer: result.text,
        blocks: turn.blocks,
        memories: turn.memories,
        turnId: result.turnId,
        runId: result.runId,
      });

      await autoLoopRepository.recordTurn(
        sessionId,
        { n: iteration, summary: summarise(result.text) },
        // Watermark the digest at the moment the turn *started*, not now: anything posted while the
        // agent was working is news it hasn't seen, and stamping "now" would silently swallow it.
        tickStartedAt,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const turn = recorder.build('');
      const blocks = [
        ...turn.blocks,
        { kind: 'text' as const, text: `\n\n⚠️ Auto loop iteration ${iteration} failed: ${message}` },
      ];
      await sessionRepository
        .addMessage(sessionId, {
          role: 'assistant',
          text: '',
          blocks,
          reasoning: turn.reasoning || undefined,
          trace: turn.trace,
          context_tokens: turn.contextTokens,
          context_window: turn.contextWindow,
        })
        .catch((e) => log.error({ err: String(e) }, 'failed to persist failed auto loop turn'));
      eventBus.emit('conversation:turn_complete', { ctx, answer: '', blocks, turnId: '', runId: '' });

      const updated = await autoLoopRepository.recordError(sessionId, iteration, message);
      log.error({ err: message, session: sessionId, iteration }, 'auto loop iteration failed');
      if (updated && updated.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
        const parked = await autoLoopRepository.setStatus(sessionId, 'error', { next_run_at: null });
        if (parked) this.emitState(parked);
        log.error(
          { session: sessionId, errors: updated.consecutive_errors },
          'auto loop parked after consecutive failures',
        );
        return;
      }
    } finally {
      recorder.stop();
      liveRuns.end(sessionId);
      sessionLock.releaseUserSession(agentId);
    }

    // Re-read: the agent may have called `loop_done` mid-turn, or the operator may have stopped it.
    const after = await autoLoopRepository.findBySession(sessionId);
    if (!after) return;
    if (after.status !== 'running' && after.status !== 'waiting') {
      this.emitState(after);
      log.info({ session: sessionId, status: after.status, iterations: after.iteration }, 'auto loop ended');
      return;
    }
    await this.rearm(sessionId, after.interval_sec);
  }

  private async rearm(sessionId: string, intervalSec: number): Promise<void> {
    const delay = Math.max(MIN_INTERVAL_SEC, intervalSec);
    const armed = await autoLoopRepository.arm(sessionId, new Date(Date.now() + delay * 1000));
    if (armed) this.emitState(armed);
    this.schedule(sessionId, delay);
  }

  /** Replay the tail of the conversation as plain chat history for the next turn. */
  private async loadHistory(sessionId: string): Promise<ChatMessage[]> {
    const messages = await sessionRepository.messages(sessionId);
    return messages
      .slice(-MAX_HISTORY_MESSAGES)
      .filter((m) => (m.text ?? '').trim().length > 0)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text ?? '' }));
  }

  private emitState(loop: AutoLoopDoc): void {
    eventBus.emit('autoloop:state', {
      sessionId: loop.session_id,
      agentName: loop.agent_name,
      status: loop.status,
      iteration: loop.iteration,
      intervalSec: loop.interval_sec,
      goal: loop.goal,
      nextRunAt: loop.next_run_at ? loop.next_run_at.toISOString() : null,
      doneReason: loop.done_reason || undefined,
      lastError: loop.last_error || undefined,
    });
  }
}

/** First paragraph-ish of the answer — enough for the next turn to know what was done. */
function summarise(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return '(no answer)';
  return clean.length > SUMMARY_CHARS ? `${clean.slice(0, SUMMARY_CHARS)}…` : clean;
}

export const autoLoopRunner = new AutoLoopRunner();
