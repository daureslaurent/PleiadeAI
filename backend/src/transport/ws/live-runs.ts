import type { TurnRecorder } from './TurnRecorder';

/**
 * The agent runs currently in flight, keyed by session id — the single source of truth for "is this
 * session busy, and what has its turn produced so far".
 *
 * Both entry points register here: a chat the operator drove (`socket.ts`) and a conversation the
 * Conversation Generator is driving on its own (`conversation-gen.service.ts`). That matters for
 * `session:subscribe`: a client opening a session whose run is *already underway* — an operator who
 * reloaded mid-turn, or one opening a generated conversation the moment it appears — is handed
 * `chat:running` plus the recorder's snapshot of the turn so far. Without it the client never turns
 * its `streaming` flag on, so the tokens arriving in the room accumulate invisibly and the turn only
 * appears when it completes.
 *
 * `controller` is only set for runs the operator can stop (a generated conversation has no stop
 * button — it ends when the interview does).
 */
interface LiveRun {
  recorder: TurnRecorder;
  controller?: AbortController;
}

const runs = new Map<string, LiveRun>();

export const liveRuns = {
  start(sessionId: string, recorder: TurnRecorder, controller?: AbortController): void {
    runs.set(sessionId, { recorder, controller });
  },

  end(sessionId: string): void {
    runs.delete(sessionId);
  },

  get(sessionId: string): LiveRun | undefined {
    return runs.get(sessionId);
  },

  has(sessionId: string): boolean {
    return runs.has(sessionId);
  },
};
