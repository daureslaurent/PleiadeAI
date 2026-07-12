import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import type { EventContext } from '../../core/event-bus/events.types';
import { sessionLock } from '../../core/session/SessionLock';
import { agentRunner } from '../../orchestrator/AgentRunner';
import { liveRuns } from '../../transport/ws/live-runs';
import { TurnRecorder } from '../../transport/ws/TurnRecorder';
import { agentRepository } from '../agents/agent.repository';
import type { ChatMessage } from '../agents/jit-builder';
import { sessionRepository } from '../sessions/session.repository';
import { generatorRepository } from './generator.repository';
import { nextQuestion, type Exchange } from './interviewer';

const log = createLogger('conversation-gen');

/** How long a conversation waits for a live user chat on the target agent before giving up. */
const YIELD_TIMEOUT_MS = 5 * 60_000;

/**
 * Drives one generated conversation: the interviewer agent asks, the target agent answers with its
 * full rig (tools, skills, delegation), `turns` times over. See `docs/conversation-generator.md`.
 *
 * The result is an ordinary session flagged `origin: 'synthetic'`, so the Conversation Quality
 * Scorer and the fine-tune dataset builder pick it up with no special-casing. The target's turns are
 * run with `persistMemory: false` — synthetic chatter must never reach its Qdrant namespace.
 */
export const conversationGenService = {
  /**
   * Generate one conversation for the given generator. Resolves to the new session's id, or `null`
   * when nothing was produced (agent gone, target busy, interviewer silent) — the reason is recorded
   * on the generator's `last_error`.
   */
  async runOnce(generatorId: string): Promise<string | null> {
    const gen = await generatorRepository.findById(generatorId);
    if (!gen) {
      log.warn({ generatorId }, 'generator not found');
      return null;
    }

    const [target, interviewer] = await Promise.all([
      agentRepository.findById(gen.target_agent_id),
      agentRepository.findById(gen.interviewer_agent_id),
    ]);
    if (!target || !interviewer) {
      const error = !target ? 'target agent no longer exists' : 'interviewer agent no longer exists';
      await generatorRepository.recordRun(gen._id, { error });
      log.warn({ generatorId, error }, 'generator run skipped');
      return null;
    }

    // A live operator chat always wins: hold off until the target is free rather than making it
    // answer the interviewer and the human at once.
    const free = await sessionLock.waitUntilFree(String(target._id), YIELD_TIMEOUT_MS);
    if (!free) {
      await generatorRepository.recordRun(gen._id, { error: 'target agent busy with a live session' });
      log.info({ agent: target.name }, 'generator run skipped: agent busy');
      return null;
    }

    // One subject per conversation, drawn from the operator's seeds ('' → the interviewer picks).
    const topic = gen.topics.length ? gen.topics[Math.floor(Math.random() * gen.topics.length)]! : '';
    const turns = Math.max(1, gen.turns);

    const session = await sessionRepository.create({
      agentId: target._id,
      agentName: target.name,
      title: topic ? `🎙 ${topic}` : `🎙 Interview — ${target.name}`,
      origin: 'synthetic',
      generatorId: gen._id,
    });
    const sessionId = String(session._id);

    // Everything below is mirrored to any Workspace watching, so a generated conversation can be read
    // as it happens instead of only after a reload (see `bridge.ts`). `depth: 0` — the target is the
    // directly-addressed agent of this session, exactly as if the operator had typed the question.
    const ctx: EventContext = {
      sessionId,
      agentId: String(target._id),
      agentName: target.name,
      depth: 0,
    };
    eventBus.emit('conversation:session_created', {
      sessionId,
      agentId: String(target._id),
      agentName: target.name,
      title: session.title,
    });

    log.info({ agent: target.name, sessionId, turns, topic }, 'generating conversation');

    const exchanges: Exchange[] = [];
    // The target's own view of the chat: what it is given as history on each follow-up turn.
    const history: ChatMessage[] = [];
    // Has anything at all been written to this session? A session with the interviewer's question in
    // it is evidence, even if the agent then failed — only a session nobody ever spoke in is deleted.
    let spoken = false;
    let failure = '';

    try {
      for (let i = 0; i < turns && !failure; i++) {
        const question = await nextQuestion({
          interviewer,
          target,
          topic,
          exchanges,
          totalTurns: turns,
        });
        // A silent interviewer ends the conversation here: keep whatever exchanges we already have
        // rather than discarding a half-good conversation.
        if (!question) {
          if (!spoken) failure = 'interviewer produced no question';
          break;
        }

        await sessionRepository.addMessage(sessionId, { role: 'user', text: question });
        eventBus.emit('chat:user_message', { ctx, content: question });
        spoken = true;

        // Mirror the run off the EventBus exactly as the socket layer does for a client that left,
        // so the persisted turn keeps its rich blocks (tool calls, sub-agent hops) — that detail is
        // the most valuable part of the training data.
        const recorder = new TurnRecorder(sessionId, target.name);
        recorder.start();
        // Publish the run so an operator opening this conversation *mid-turn* — the normal case, since
        // the session only appears once it starts — is handed `chat:running` + a snapshot of the turn
        // so far on subscribe, and watches the rest stream in. No AbortController: a generated
        // conversation has no stop button; it ends when the interview does.
        liveRuns.start(sessionId, recorder);
        let answer = '';
        try {
          const result = await agentRunner.run({
            agentName: target.name,
            sessionId,
            depth: 0,
            userText: question,
            history: [...history],
            persistMemory: false,
          });
          answer = result.text;
          const turn = recorder.build(answer);
          await sessionRepository.addMessage(sessionId, {
            role: 'assistant',
            text: answer,
            blocks: turn.blocks,
            reasoning: turn.reasoning || undefined,
            trace: turn.trace,
            memories: turn.memories,
            context_tokens: turn.contextTokens,
            context_window: turn.contextWindow,
            turn_id: result.turnId,
            run_id: result.runId,
          });
          // Settle the watching client's live buffer into a finished turn. The turn is already
          // persisted here, so `persisted: true` on the wire stops the client saving it twice.
          eventBus.emit('conversation:turn_complete', {
            ctx,
            answer,
            blocks: turn.blocks,
            memories: turn.memories,
            turnId: result.turnId,
            runId: result.runId,
          });
        } catch (err) {
          // The agent's run blew up (a dead endpoint, or — seen in the wild — llama.cpp refusing to
          // parse a tool call whose argument string is too long). Keep the conversation: persist the
          // partial turn with an error note, exactly as the socket layer does for a live chat whose
          // inference dies. Deleting it here would leave the operator with a pulsing agent and no
          // trace of why. The conversation ends at this exchange.
          failure = err instanceof Error ? err.message : String(err);
          const turn = recorder.build('');
          const blocks = [
            ...turn.blocks,
            { kind: 'text' as const, text: `\n\n⚠️ Conversation interrupted — the agent's run failed: ${failure}` },
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
            .catch((e) => log.error({ err: String(e) }, 'failed to persist interrupted turn'));
          eventBus.emit('conversation:turn_complete', {
            ctx,
            answer: '',
            blocks,
            turnId: '',
            runId: '',
          });
          log.error({ err: failure, agent: target.name, sessionId }, 'generated conversation interrupted');
          break;
        } finally {
          recorder.stop();
          liveRuns.end(sessionId);
        }

        exchanges.push({ question, answer });
        history.push({ role: 'user', content: question });
        history.push({ role: 'assistant', content: answer });
      }

      if (!spoken) {
        // Nobody ever said anything — don't leave an empty session lying around in the pool.
        await sessionRepository.delete(sessionId);
        await generatorRepository.recordRun(gen._id, { error: failure || 'interviewer produced no question' });
        return null;
      }

      // A conversation that broke mid-way is still kept and still readable, but it isn't a success:
      // the error is recorded so the Conversations page shows why, and the count doesn't move.
      await generatorRepository.recordRun(gen._id, failure ? { error: failure } : {});
      log.info(
        { agent: target.name, sessionId, exchanges: exchanges.length, failed: Boolean(failure) },
        'conversation generated',
      );
      return sessionId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A watching client is mid-turn and would spin forever: close the turn out. Empty blocks →
      // the client clears its "working" state without appending a turn.
      eventBus.emit('conversation:turn_complete', {
        ctx,
        answer: '',
        blocks: [],
        turnId: '',
        runId: '',
      });
      await generatorRepository.recordRun(gen._id, { error: message });
      log.error({ err: message, agent: target.name, sessionId }, 'conversation generation failed');
      // Keep whatever was said (it is still readable evidence of what went wrong); drop only a
      // session nobody ever spoke in.
      if (!spoken) await sessionRepository.delete(sessionId).catch(() => undefined);
      return spoken ? sessionId : null;
    }
  },
};
