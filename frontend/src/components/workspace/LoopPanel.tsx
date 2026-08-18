import { useCallback, useEffect, useState } from 'react';
import { Repeat, Square, Play, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { autoLoopsApi, type Agent } from '../../lib/api';
import { useStream } from '../../store/stream';
import { usePersistentState } from '../../hooks/usePersistentState';

/**
 * The auto-agent Loop panel (`AUTO_AGENT_PLAN.md` §5): where the operator hands an `auto_mode` agent
 * a standing goal and an interval and leaves it to drive its own conversation.
 *
 * The panel is a *view* of backend state, never the owner of it. The loop lives in Mongo and is
 * driven by `AutoLoopRunner`, so this form's job ends the moment Start returns: everything after
 * that — status, iteration, the countdown — comes back over the socket as `auto_loop`. Closing the
 * browser is therefore a no-op for a running loop, which is the entire reason it isn't a
 * `setInterval` in here (the neighbouring auto-continue toggle, which *is* client-side, dies with
 * the tab by design — it only reacts to a turn ending).
 */

const DEFAULT_CONTINUE =
  'Continue working toward your goal. Make one concrete step of progress, then report what you did.';

interface Props {
  agent: Agent;
  sessionId: string | null;
  /** Creates the session if the operator arms a loop on a conversation that has no turns yet. */
  onEnsureSession: () => Promise<string>;
  onClose: () => void;
}

/** `waiting`/`running` are the live states; the rest are terminal (see the model's status comment). */
function isLive(status: string | undefined): boolean {
  return status === 'waiting' || status === 'running';
}

export function LoopPanel({ agent, sessionId, onEnsureSession, onClose }: Props) {
  const { autoLoop, setAutoLoop } = useStream();

  // The form is remembered per browser, not per session: an operator running the same kind of loop
  // over and over shouldn't retype the interval and the continue phrasing every time.
  const [goal, setGoal] = usePersistentState('loop:goal', '');
  const [seed, setSeed] = usePersistentState('loop:seed', '');
  const [continueText, setContinueText] = usePersistentState('loop:continue', DEFAULT_CONTINUE);
  const [intervalSec, setIntervalSec] = usePersistentState('loop:interval', 300);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Load whatever loop this conversation already has, so re-opening the panel on a running loop shows
  // its real state rather than an empty form.
  useEffect(() => {
    if (!sessionId) {
      setAutoLoop(null);
      return;
    }
    let cancelled = false;
    void autoLoopsApi
      .get(sessionId)
      .then((loop) => {
        if (cancelled || !loop) return;
        setAutoLoop({
          type: 'auto_loop',
          sessionId: loop.session_id,
          agentName: loop.agent_name,
          status: loop.status,
          iteration: loop.iteration,
          intervalSec: loop.interval_sec,
          goal: loop.goal,
          nextRunAt: loop.next_run_at,
          doneReason: loop.done_reason || undefined,
          lastError: loop.last_error || undefined,
        });
        // Re-arming a stopped loop almost always means running the same one again — prefill from it.
        if (loop.goal) setGoal(loop.goal);
        if (loop.continue_text) setContinueText(loop.continue_text);
        if (loop.interval_sec) setIntervalSec(loop.interval_sec);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId, setAutoLoop, setGoal, setContinueText, setIntervalSec]);

  // Local ticker for the countdown only. It never decides anything — if it drifts, the next
  // `auto_loop` event corrects it; the backend's timer is what actually fires.
  useEffect(() => {
    if (!isLive(autoLoop?.status)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [autoLoop?.status]);

  const start = useCallback(async () => {
    if (!goal.trim()) {
      setError('Give the agent a goal — every iteration is measured against it.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sid = sessionId ?? (await onEnsureSession());
      await autoLoopsApi.start(sid, {
        goal: goal.trim(),
        seed: seed.trim(),
        continueText: continueText.trim(),
        intervalSec,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [goal, seed, continueText, intervalSec, sessionId, onEnsureSession]);

  const stopLoop = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      await autoLoopsApi.stop(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  const live = isLive(autoLoop?.status);
  const countdown =
    autoLoop?.status === 'waiting' && autoLoop.nextRunAt
      ? Math.max(0, Math.round((new Date(autoLoop.nextRunAt).getTime() - now) / 1000))
      : null;

  return (
    <div className="mb-2 rounded-lg border border-accent/25 bg-accent/[0.04] p-3">
      <div className="flex items-center gap-2">
        <Repeat size={14} className="text-accent" />
        <span className="text-xs font-medium text-slate-200">Auto loop</span>
        <span className="text-[11px] text-slate-500">
          {agent.name} drives this conversation itself, one turn per interval.
        </span>
        <button
          onClick={onClose}
          className="ml-auto text-[11px] text-slate-500 transition-colors hover:text-slate-300"
        >
          Hide
        </button>
      </div>

      {/* Live state, once a loop exists. Rendered from the server's last word, not the form. */}
      {autoLoop && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-white/[0.06] bg-black/20 px-2.5 py-1.5 text-[11px]">
          {autoLoop.status === 'running' && (
            <span className="flex items-center gap-1.5 text-accent">
              <Loader2 size={12} className="animate-spin" /> running
            </span>
          )}
          {autoLoop.status === 'waiting' && (
            <span className="text-slate-300">
              waiting{countdown !== null ? ` · next turn in ${countdown}s` : ''}
            </span>
          )}
          {autoLoop.status === 'done' && (
            <span className="flex items-center gap-1.5 text-emerald-400">
              <CheckCircle2 size={12} /> the agent called it done
            </span>
          )}
          {autoLoop.status === 'stopped' && <span className="text-slate-400">stopped</span>}
          {autoLoop.status === 'error' && (
            <span className="flex items-center gap-1.5 text-red-400">
              <AlertTriangle size={12} /> stopped after repeated failures
            </span>
          )}
          <span className="text-slate-500">· iteration {autoLoop.iteration}</span>
          {autoLoop.doneReason && (
            <span className="w-full text-slate-400">{autoLoop.doneReason}</span>
          )}
          {autoLoop.lastError && autoLoop.status === 'error' && (
            <span className="w-full text-red-400/80">{autoLoop.lastError}</span>
          )}
        </div>
      )}

      <div className="mt-2 space-y-2">
        <label className="block">
          <span className="text-[11px] text-slate-400">
            Goal — restated to the agent on every turn, so a long loop can't drift off it
          </span>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={live}
            rows={2}
            placeholder="What it should be working toward, and how you'll know it's done."
            className="mt-1 w-full resize-none rounded-md border border-white/10 bg-black/20 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-accent/60 disabled:opacity-50"
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-slate-400">Kickoff message — sent on the first turn only</span>
          <textarea
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            disabled={live}
            rows={2}
            placeholder="Where to start. Leave blank to open with the goal itself."
            className="mt-1 w-full resize-none rounded-md border border-white/10 bg-black/20 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-accent/60 disabled:opacity-50"
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-slate-400">Continue message — sent on every later turn</span>
          <textarea
            value={continueText}
            onChange={(e) => setContinueText(e.target.value)}
            disabled={live}
            rows={2}
            placeholder={DEFAULT_CONTINUE}
            className="mt-1 w-full resize-none rounded-md border border-white/10 bg-black/20 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-accent/60 disabled:opacity-50"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            Loop time
            <input
              type="number"
              min={10}
              step={10}
              value={intervalSec}
              onChange={(e) => setIntervalSec(Math.max(10, Number(e.target.value) || 10))}
              disabled={live}
              className="w-20 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-xs text-slate-200 outline-none focus:border-accent/60 disabled:opacity-50"
            />
            seconds between turns
          </label>

          {live ? (
            <button
              onClick={stopLoop}
              disabled={busy}
              className="ml-auto flex items-center gap-1.5 rounded-md bg-red-500/15 px-2.5 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/25 disabled:opacity-50"
            >
              <Square size={12} className="fill-current" /> Stop loop
            </button>
          ) : (
            <button
              onClick={start}
              disabled={busy || !goal.trim()}
              className="ml-auto flex items-center gap-1.5 rounded-md bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
            >
              <Play size={12} /> Start loop
            </button>
          )}
        </div>

        {error && <p className="text-[11px] text-red-400">{error}</p>}
        <p className="text-[11px] leading-relaxed text-slate-500">
          The loop runs on the backend — it keeps going with this tab closed. It ends when the agent
          calls <code>loop_done</code> because the goal is met, or when you stop it. Each turn the
          agent is also shown replies awaiting it and what's new on the forum since its last turn.
        </p>
      </div>
    </div>
  );
}
