import { createLogger } from '../../config/logger';
import { sessionLock } from '../../core/session/SessionLock';
import { agentRunner } from '../../orchestrator/AgentRunner';
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

    log.info({ agent: target.name, sessionId, turns, topic }, 'generating conversation');

    const exchanges: Exchange[] = [];
    // The target's own view of the chat: what it is given as history on each follow-up turn.
    const history: ChatMessage[] = [];

    try {
      for (let i = 0; i < turns; i++) {
        const question = await nextQuestion({
          interviewer,
          target,
          topic,
          exchanges,
          totalTurns: turns,
        });
        // A silent interviewer ends the conversation here: keep whatever exchanges we already have
        // rather than discarding a half-good conversation.
        if (!question) break;

        await sessionRepository.addMessage(sessionId, { role: 'user', text: question });

        // Mirror the run off the EventBus exactly as the socket layer does for a client that left,
        // so the persisted turn keeps its rich blocks (tool calls, sub-agent hops) — that detail is
        // the most valuable part of the training data.
        const recorder = new TurnRecorder(sessionId, target.name);
        recorder.start();
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
        } finally {
          recorder.stop();
        }

        exchanges.push({ question, answer });
        history.push({ role: 'user', content: question });
        history.push({ role: 'assistant', content: answer });
      }

      if (!exchanges.length) {
        // Nothing was said — don't leave an empty session lying around in the pool.
        await sessionRepository.delete(sessionId);
        await generatorRepository.recordRun(gen._id, { error: 'interviewer produced no question' });
        return null;
      }

      await generatorRepository.recordRun(gen._id, {});
      log.info({ agent: target.name, sessionId, exchanges: exchanges.length }, 'conversation generated');
      return sessionId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await generatorRepository.recordRun(gen._id, { error: message });
      log.error({ err: message, agent: target.name, sessionId }, 'conversation generation failed');
      // Keep a partial conversation (it is still usable data); drop a session that never got a turn.
      if (!exchanges.length) await sessionRepository.delete(sessionId).catch(() => undefined);
      return exchanges.length ? sessionId : null;
    }
  },
};
