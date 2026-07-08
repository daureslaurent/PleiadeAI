import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { createLogger } from '../../config/logger';
import { verifyToken } from '../http/jwt';
import { sessionLock } from '../../core/session/SessionLock';
import { agentRunner, RunAbortedError } from '../../orchestrator/AgentRunner';
import { agentRepository } from '../../domain/agents/agent.repository';
import { sessionRepository } from '../../domain/sessions/session.repository';
import { generateSessionTitle, type TitleTurn } from '../../domain/sessions/session-titler';
import type { ChatMessage } from '../../domain/agents/jit-builder';
import type { ImageBlock } from '../../core/event-bus/events.types';
import { attachBridge } from './bridge';
import { askUserBroker } from './AskUserBroker';
import { TurnRecorder, type Block } from './TurnRecorder';

const log = createLogger('ws');

// User-turn numbers at which we (re)generate the auto title: the opening turn, then two refinements
// as the conversation accumulates context, after which the topic is settled. Bounds titling cost.
const TITLE_AT_TURNS = new Set([1, 3, 6]);

interface ChatMessageInput {
  agentName: string;
  content: string;
  images?: ImageBlock[];
  /** Optional client-supplied session id; generated if absent. */
  sessionId?: string;
  /** Prior turns of this session (text-only) so the agent has conversational context. */
  history?: ChatMessage[];
}

/**
 * socket.io server. The JWT is verified during the handshake (spec §2): an invalid/expired
 * token drops the connection immediately. Each chat message runs an agent turn while holding
 * the session lock, so concurrent cron jobs on the same agent yield to the live user.
 */
export function attachSocket(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    // Chat messages can carry attached images (base64 data URLs); the default 1MB cap would drop a
    // message with a couple of photos. 16MB comfortably fits several downscaled images per turn.
    maxHttpBufferSize: 16 * 1024 * 1024,
  });

  // Handshake auth middleware.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('unauthorized'));
    try {
      verifyToken(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  attachBridge(io);

  // Live runs keyed by session id, so a `chat:stop` (or a disconnect) can abort the in-flight
  // agent turn — tearing down its inference stream and every sub-agent hop it spawned.
  const runControllers = new Map<string, AbortController>();

  // The `TurnRecorder` mirroring each live run, keyed by session id. Kept accessible outside the
  // originating `chat:message` handler so a client that (re)subscribes mid-turn — after a reload or
  // an in-app navigation — can be handed the in-flight turn's current state to resume from.
  const runRecorders = new Map<string, TurnRecorder>();

  io.on('connection', (socket: Socket) => {
    log.info({ id: socket.id }, 'client connected');

    // Sessions this connection has run, so pending `ask_user` prompts can be cancelled on disconnect.
    const sessions = new Set<string>();

    socket.on('chat:message', async (input: ChatMessageInput) => {
      const sessionId = input.sessionId ?? randomUUID();
      sessions.add(sessionId);
      socket.join(sessionId); // receive this turn's streamed events
      socket.emit('session', { sessionId });

      // Resolve once so acquire/release target the same lock key.
      const agent = await agentRepository.findByName(input.agentName);
      const lockKey = agent ? String(agent._id) : input.agentName;

      const controller = new AbortController();
      runControllers.set(sessionId, controller);

      // Mirror the turn on the backend so its rich blocks (tools + sub-agent hops) can be persisted
      // even if the client is gone when the run ends — otherwise a reload keeps only plain text.
      const recorder = new TurnRecorder(sessionId, input.agentName);
      recorder.start();
      runRecorders.set(sessionId, recorder);

      sessionLock.acquireUserSession(lockKey);
      try {
        const { text: answer, turnId, runId } = await agentRunner.run({
          agentName: input.agentName,
          sessionId,
          depth: 0,
          userText: input.content,
          images: input.images,
          history: input.history,
          signal: controller.signal,
        });
        if (socket.connected) {
          // Normal case: the originating client is still here — it renders the streamed turn and
          // persists it (with the rich inline blocks) via the REST API, as before. `runId` (the
          // depth-0 agent-run) lets the client tag the saved message so the top-level turn's quality
          // score attaches on refresh; `turnId` groups it with any sub-agent runs.
          socket.emit('chat:done', { sessionId, answer, turnId, runId });
        } else {
          // The client left mid-run (e.g. a browser refresh). Persist the *rich* turn ourselves —
          // reconstructed from the same event stream — so tool calls and sub-agent hops survive, not
          // just the plain answer. Broadcast to anyone who re-subscribed; `persisted` tells them to
          // render (from the included blocks) but NOT save again.
          const turn = recorder.build(answer);
          const hasContent = turn.blocks.length > 0 || answer.trim().length > 0;
          if (hasContent) {
            await sessionRepository
              .addMessage(sessionId, {
                role: 'assistant',
                text: answer,
                blocks: turn.blocks,
                reasoning: turn.reasoning || undefined,
                trace: turn.trace,
                context_tokens: turn.contextTokens,
                context_window: turn.contextWindow,
                turn_id: turnId,
                run_id: runId,
              })
              .catch((e) => log.error({ err: String(e) }, 'server-side persist failed'));
          }
          io.to(sessionId).emit('chat:done', {
            sessionId,
            answer,
            persisted: true,
            blocks: turn.blocks,
            turnId,
            runId,
          });
        }

        // (Re)generate the conversation title at a few growth points and push it to the sidebar live.
        // The first turn names the chat; later turns refine it from the accumulated transcript so a
        // conversation that drifted off its opening gets a title matching where it ended up.
        // Fire-and-forget so it never delays the turn completing.
        const priorUserTurns = (input.history ?? []).filter((m) => m.role === 'user').length;
        const turnNumber = priorUserTurns + 1;
        if (TITLE_AT_TURNS.has(turnNumber) && answer.trim()) {
          const transcript: TitleTurn[] = [
            ...(input.history ?? [])
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
            { role: 'user', content: input.content },
            { role: 'assistant', content: answer },
          ];
          void (async () => {
            // Never overwrite a title the operator set by hand.
            const session = await sessionRepository.findById(sessionId).catch(() => null);
            if (session && session.title_auto === false) return;
            // Signal the sidebar to show a spinner while titling; always emit a terminal event (with
            // or without a title) so the spinner can never get stuck spinning.
            io.emit('session:title', { sessionId, pending: true });
            try {
              const title = await generateSessionTitle(transcript, agent);
              if (title) {
                await sessionRepository.rename(sessionId, title, true).catch(() => undefined);
              }
              io.emit('session:title', { sessionId, title: title ?? undefined, pending: false });
            } catch {
              io.emit('session:title', { sessionId, pending: false });
            }
          })();
        }
      } catch (err) {
        // Operator hit "stop": end the turn cleanly, keeping whatever streamed so far. No error banner.
        if (err instanceof RunAbortedError || controller.signal.aborted) {
          log.info({ sessionId }, 'chat run stopped by user');
          socket.emit('chat:done', { sessionId, answer: '' });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err: message }, 'chat run failed');

          // Graceful failure: an inference/network drop can strike mid-turn after the model has
          // already streamed text and run tools/sub-agents. Rebuild that partial turn from the
          // recorder and persist it with an explicit error note, so the work isn't discarded —
          // even if the client is gone. Route terminal signals to the room when it has left.
          const turn = recorder.build('');
          const blocks: Block[] = [
            ...turn.blocks,
            { kind: 'text', text: `\n\n⚠️ Response interrupted — inference failed: ${message}` },
          ];
          const hasPartial = turn.blocks.length > 0;
          if (hasPartial) {
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
              .catch((e) => log.error({ err: String(e) }, 'partial persist failed'));
          }

          const target = socket.connected ? socket : io.to(sessionId);
          target.emit('system_alert', { type: 'system_alert', level: 'error', message });
          // Terminal signal stops the "working" state; carry the saved partial so the live UI keeps
          // it (and doesn't double-persist when we already did).
          target.emit('chat:done', {
            sessionId,
            answer: '',
            error: message,
            persisted: hasPartial,
            blocks: hasPartial ? blocks : undefined,
          });
        }
      } finally {
        recorder.stop();
        runRecorders.delete(sessionId);
        runControllers.delete(sessionId);
        sessionLock.releaseUserSession(lockKey);
      }
    });

    // Operator hit "stop" on a running turn: abort the inference/hop loop, and unblock any pending
    // `ask_user` for this session so a run parked on an operator prompt tears down too.
    socket.on('chat:stop', ({ sessionId }: { sessionId: string }) => {
      const controller = runControllers.get(sessionId);
      if (controller) {
        controller.abort();
        log.info({ sessionId }, 'stop requested');
      }
      askUserBroker.cancelSession(sessionId);
    });

    // A (re)loaded client re-attaching to a session it already has on screen: join the room so it
    // receives this session's live stream + terminal `chat:done`, and — if a run is still in flight
    // (e.g. the user refreshed mid-turn) — tell it so the UI shows "working" instead of "stopped".
    socket.on('session:subscribe', ({ sessionId }: { sessionId: string }) => {
      if (!sessionId) return;
      socket.join(sessionId);
      sessions.add(sessionId);
      if (runControllers.has(sessionId)) {
        socket.emit('chat:running', { sessionId });
        // Hand this client the in-flight turn as it stands right now (prose streamed so far, tool
        // calls, and any sub-agent hops — open or closed), so it rebuilds the full live turn instead
        // of only the tail that arrives after it reconnected. Snapshotting synchronously here (before
        // any further bus event can run) then emitting on this same socket keeps it ordered ahead of
        // subsequent room events, so the client adopts the base then appends the deltas.
        const recorder = runRecorders.get(sessionId);
        if (recorder) socket.emit('chat:snapshot', recorder.snapshot());
      }
    });

    // Operator's answer to a blocking `ask_user` — unblocks the waiting agent run.
    socket.on('ask_user:response', ({ requestId, answer }: { requestId: string; answer: string }) => {
      askUserBroker.resolve(requestId, String(answer ?? ''));
    });

    // LLM Debug page (in)subscription — joins/leaves the global `llama-log` room that the bridge
    // streams raw-call start/delta/end events to. Not tied to any chat session.
    socket.on('llama:subscribe', () => socket.join('llama-log'));
    socket.on('llama:unsubscribe', () => socket.leave('llama-log'));

    socket.on('disconnect', () => {
      // A disconnect (notably a browser refresh) must NOT kill the run — it keeps streaming to the
      // session room and, if the client is gone at completion, its turn is persisted server-side.
      // We only clear pending `ask_user` prompts, which can't be answered without a live client.
      for (const id of sessions) askUserBroker.cancelSession(id);
      log.info({ id: socket.id }, 'client disconnected');
    });
  });

  return io;
}
