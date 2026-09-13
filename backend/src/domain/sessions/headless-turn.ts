import { randomUUID } from 'node:crypto';
import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import type { EventContext } from '../../core/event-bus/events.types';
import { agentRunner, RunAbortedError, type RunInput, type RunResult } from '../../orchestrator/AgentRunner';
import { activeRuns } from '../../orchestrator/active-runs';
import type { ChatMessage } from '../agents/jit-builder';
import { TurnRecorder } from '../../transport/ws/TurnRecorder';
import { liveRuns } from '../../transport/ws/live-runs';
import { sessionRepository } from './session.repository';

const log = createLogger('headless-turn');

/** How much of the conversation a continued headless turn replays, as the auto loop does. */
const MAX_HISTORY_MESSAGES = 30;

export interface HeadlessTurnInput {
  /** The conversation the turn is recorded into. */
  sessionId: string;
  agentId: string;
  agentName: string;
  userText: string;
  /**
   * Replay the conversation's earlier turns as history — a Telegram chat continues, a cron run starts
   * fresh. Read before this turn's user message is added.
   */
  continueConversation?: boolean;
  /**
   * Run the agent under a different session than the one recorded into. A flow's agent node runs
   * under the flow run's session, which is where its artifacts live and what the flow page watches.
   */
  runSessionId?: string;
  /** Aborts the run from outside (Telegram's /cancel, a stopped flow) — the Workspace's stop works too. */
  signal?: AbortSignal;
  /** Everything else `AgentRunner.run` takes (images, persistMemory…). */
  run?: Omit<RunInput, 'agentName' | 'sessionId' | 'depth' | 'userText' | 'history' | 'signal' | 'runId'>;
}

/**
 * One agent turn nobody typed in the Workspace, kept as an ordinary conversation.
 *
 * The same shape the forum runners and the auto loop already follow: the user message is persisted and
 * announced, a `TurnRecorder` mirrors the run off the bus (nobody may be watching, and the tool calls
 * and sub-agent bubbles are most of what the operator will come back to read), `liveRuns` lets a
 * Workspace opening the conversation mid-run pick it up and stop it, and the finished turn is persisted
 * with `persisted: true` so a watching client renders it without saving it twice.
 *
 * A failure is persisted too — with whatever streamed before it — and then rethrown, so the caller
 * still reports it its own way (a run result, a Telegram reply, a failed node).
 */
export async function runHeadlessTurn(input: HeadlessTurnInput): Promise<RunResult> {
  const { sessionId, agentName, userText } = input;
  const ctx: EventContext = { sessionId, agentId: input.agentId, agentName, depth: 0 };

  const history: ChatMessage[] | undefined = input.continueConversation
    ? (await sessionRepository.messages(sessionId))
        .slice(-MAX_HISTORY_MESSAGES)
        .filter((m) => (m.text ?? '').trim().length > 0)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text ?? '' }))
    : undefined;

  await sessionRepository.addMessage(sessionId, { role: 'user', text: userText });
  eventBus.emit('chat:user_message', { ctx, content: userText });

  // Minted here so a recorder reading another session's events can tell this run's from a sibling's.
  const runId = randomUUID();
  const recorder = new TurnRecorder(
    sessionId,
    agentName,
    input.runSessionId ? { runSessionId: input.runSessionId, rootRunId: runId } : null,
  );
  recorder.start();
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', onOuterAbort, { once: true });
  liveRuns.start(sessionId, recorder, controller);
  // The run marks its own session busy; one recorded elsewhere marks this conversation too.
  const unmark = input.runSessionId ? activeRuns.markSession(sessionId) : undefined;

  try {
    const result = await agentRunner.run({
      ...input.run,
      agentName,
      sessionId: input.runSessionId ?? sessionId,
      depth: 0,
      userText,
      history,
      signal: controller.signal,
      runId,
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
    eventBus.emit('conversation:turn_complete', {
      ctx,
      answer: result.text,
      blocks: turn.blocks,
      memories: turn.memories,
      turnId: result.turnId,
      runId: result.runId,
    });
    return result;
  } catch (err) {
    const stopped = err instanceof RunAbortedError || controller.signal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    const turn = recorder.build('');
    const blocks = stopped
      ? turn.blocks
      : [...turn.blocks, { kind: 'text' as const, text: `\n\n⚠️ The run failed: ${message}` }];
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
      .catch((e) => log.error({ err: String(e), sessionId }, 'failed to persist interrupted headless turn'));
    eventBus.emit('conversation:turn_complete', { ctx, answer: '', blocks, turnId: '', runId: '' });
    throw err;
  } finally {
    input.signal?.removeEventListener('abort', onOuterAbort);
    unmark?.();
    recorder.stop();
    liveRuns.end(sessionId);
  }
}

/**
 * Create a headless conversation and tell every open Workspace, so the row appears in the agent's
 * list the moment the run starts rather than on the next reload.
 */
export async function openHeadlessSession(input: {
  agentId: string;
  agentName: string;
  title: string;
  origin: 'cron' | 'telegram' | 'flow';
  scheduleId?: string;
  telegramChatId?: number;
  flowId?: string;
  flowRunId?: string;
}): Promise<string> {
  const session = await sessionRepository.create({
    agentId: input.agentId,
    agentName: input.agentName,
    title: input.title,
    origin: input.origin,
    scheduleId: input.scheduleId,
    telegramChatId: input.telegramChatId,
    flowId: input.flowId,
    flowRunId: input.flowRunId,
  });
  const sessionId = String(session._id);
  eventBus.emit('conversation:session_created', {
    sessionId,
    agentId: input.agentId,
    agentName: input.agentName,
    title: input.title,
    origin: input.origin,
  });
  return sessionId;
}

/** A one-line title out of a prompt, for a conversation nobody named. */
export function titleFrom(prefix: string, text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  const body = clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
  return body ? `${prefix} · ${body}` : prefix;
}
