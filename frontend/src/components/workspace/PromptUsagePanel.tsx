import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hash, PieChart, RefreshCw } from 'lucide-react';
import { llmDebugApi, type Agent, type LlamaCallRecord, type PromptUsageBreakdown } from '../../lib/api';
import { useStream } from '../../store/stream';
import { useLiveUsageGuess } from '../../store/usePromptUsageGuess';
import { UsageBar } from './UsageBar';
import { UsageDetailList } from './UsageDetailList';

interface Props {
  sessionId: string | null;
  agent: Agent | null;
}

/**
 * **Usage** — where this conversation's context window actually goes.
 *
 * The Prompt tab replays the conversation message by message; this one asks the question that
 * message list can't answer: *which part of the agent's configuration is eating the window*. The
 * backend cuts the assembled system message back into the modules it was glued from, sizes the tool
 * schemas (billed on every call, present in no message) and folds the conversation into role rows —
 * a 15%-of-window `AGENTS.md` is visible as a thing you could go and shorten.
 *
 * **The breakdown is pushed, not polled.** The run that assembles the prompt sizes it and emits
 * `prompt_usage` (`store/stream.ts`): once per inference pass, carrying the prompt *as sent*, and
 * once when the turn settles. So a long tool loop redraws this panel as it grows, and nothing here
 * waits on the fire-and-forget capture write that used to be the only source — which is what made
 * the tab sit on "no inference call captured" through an entire turn.
 *
 * **The fetch is the cold-start path only.** Opening a session that hasn't run a turn in this tab's
 * lifetime has no pushed reading to show, so the panel sizes that session's last *captured* call
 * once — over the same backend sizer the live path runs, so the two can't disagree about the rows.
 * It re-arms whenever the session changes, and the refresh button re-runs it on demand.
 *
 * **Between exact readings the bar still moves.** While tokens are streaming, `useLiveUsageGuess`
 * re-estimates the growing tail (assistant text, tool output, reasoning) on top of the last exact
 * breakdown, so the bar climbs every render rather than stepping once per tool call.
 *
 * **It never clears.** A fetch that fails or comes back empty leaves the last good breakdown up
 * (flagged stale) rather than blanking — a window that was measured a second ago is still the truest
 * thing we know, and an empty panel is strictly less informative.
 */
export function PromptUsagePanel({ sessionId, agent }: Props) {
  const streaming = useStream((s) => s.streaming);
  // The run's own readings: `liveContext` is this turn's climbing prompt total, `contextUsage` the
  // settled one. Either lets the meter render with no breakdown in hand at all.
  const liveContext = useStream((s) => s.liveContext);
  const settledContext = useStream((s) => s.contextUsage);
  // The pushed breakdown — the primary source. Present from the first pass of the first turn.
  const pushed = useStream((s) => s.promptUsage);
  const pushedPhase = useStream((s) => s.promptUsagePhase);

  const [call, setCall] = useState<LlamaCallRecord | null>(null);
  const [fetched, setFetched] = useState<PromptUsageBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);

  /** Bumped on every session change so a slow read can't paint the previous conversation's window. */
  const genRef = useRef(0);

  /** Size the session's most recent captured call — the cold-start / manual-refresh path. */
  const load = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    const gen = genRef.current;
    setLoading(true);
    try {
      const rows = await llmDebugApi.bySession(sessionId, 12);
      // The last pass carries the fullest context — that's the window the next turn starts from.
      const latest = rows.at(-1) ?? null;
      if (!latest) {
        if (gen === genRef.current) setStale(false);
        return;
      }
      const breakdown = await llmDebugApi.usageBreakdown(
        latest.request.messages ?? [],
        latest.tools ?? undefined,
        agent?._id ?? null,
      );
      // The operator switched conversation while this was in flight: drop it on the floor rather
      // than paint another session's window over theirs.
      if (gen !== genRef.current) return;
      setCall(latest);
      setFetched(breakdown);
      setStale(false);
    } catch {
      // Keep whatever is on screen; the refresh button (or the next turn's push) tries again.
      if (gen === genRef.current) setStale(true);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [sessionId, agent?._id]);

  // Switching sessions is the one time the panel must forget: another conversation's window is not
  // a stale view of this one, it's the wrong answer. (`promptUsage` is cleared by the store itself.)
  useEffect(() => {
    genRef.current += 1;
    setCall(null);
    setFetched(null);
    setStale(false);
  }, [sessionId]);

  // Cold start only. A session whose run is already pushing readings needs no fetch at all — and
  // firing one mid-turn would spend a tokenize pass to produce something older than what's on screen.
  useEffect(() => {
    if (!sessionId || pushed) return;
    void load();
  }, [sessionId, pushed, load]);

  // The pushed breakdown wins: it is this turn's actual prompt, where the fetched one is the last
  // call that happened to be captured.
  const exact = pushed ?? fetched;
  const guess = useLiveUsageGuess(exact, streaming);
  const isGuess = streaming && guess !== null;
  const shown = isGuess ? guess : exact;

  // The meter prefers the run's own exact reading while a turn is live, then the sized breakdown,
  // then the capture's reported prompt tokens.
  const reading = liveContext ?? settledContext;
  const breakdownTotal = shown?.total ?? shown?.sum ?? null;
  const total =
    (streaming && liveContext ? liveContext.promptTokens : null) ??
    breakdownTotal ??
    reading?.promptTokens ??
    call?.usage?.promptTokens ??
    null;
  const windowSize = shown?.contextWindow || reading?.contextWindow || 0;
  const fill = windowSize > 0 && total !== null ? total / windowSize : 0;
  const partCount = useMemo(
    () => (shown ? shown.moduleGroups.length + shown.segments.filter((s) => s.kind !== 'module').length : 0),
    [shown],
  );
  // What the numbers on screen are: a between-render estimate, the run's own mid-turn reading, or
  // the settled window. Said out loud so nobody reads an estimate as a measurement.
  const sourceLabel = isGuess
    ? 'estimated'
    : streaming || pushedPhase === 'live'
      ? 'live'
      : null;

  // Empty only when there is genuinely nothing to say: no breakdown, no reading from the live run,
  // no capture, and no read in flight. A finished turn stays on screen; a live one shows its meter.
  if (!sessionId || (!call && !shown && !reading && !loading)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <PieChart size={26} className="text-slate-600" />
        <p className="text-xs text-slate-500">
          {sessionId
            ? 'Nothing sent to the model yet. Send a message to see where the context goes.'
            : 'Pick a session to see where its context goes.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Window meter — the headline number, before any breakdown. */}
      <div className="border-b hairline px-3 py-2.5">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-lg text-slate-100">
            {total !== null ? total.toLocaleString() : '—'}
          </span>
          {windowSize > 0 && (
            <span className="font-mono text-[11px] text-slate-500">
              / {windowSize.toLocaleString()} tok
            </span>
          )}
          {sourceLabel && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-slate-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              {sourceLabel}
            </span>
          )}
          <span
            className={`ml-auto font-mono text-[11px] ${
              fill > 0.8 ? 'text-red-400' : fill > 0.5 ? 'text-amber-400' : 'text-slate-400'
            }`}
          >
            {windowSize > 0 ? `${Math.round(fill * 100)}% of window` : ''}
          </span>
          <button
            onClick={() => void load()}
            title={stale ? "Couldn't size the last call — retry" : 'Re-read the last captured call'}
            className={`rounded p-1 transition-colors hover:raise-2 hover:text-slate-300 ${
              stale ? 'text-amber-400' : 'text-slate-500'
            }`}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {shown && <UsageBar breakdown={shown} isGuess={isGuess} />}

        <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-slate-600">
          <span className="truncate">{call?.model ?? ''}</span>
          {call?.agentName && <span className="truncate text-slate-500">{call.agentName}</span>}
          <span className="ml-auto flex items-center gap-1">
            <Hash size={9} />
            {(shown?.sum ?? 0).toLocaleString()} in {partCount} parts
          </span>
        </div>
      </div>

      {/* Detail: every module and category, its tokens and share — expand a module for its blocks.
          Kept up while a refresh runs: a list that blanks on every attempt is worse than one that's
          a second stale, and the spinner already says a read is in flight. */}
      {shown ? (
        <UsageDetailList breakdown={shown} />
      ) : (
        <p className="px-3 py-3 text-[11px] text-slate-500">
          {loading
            ? 'Sizing the last call…'
            : 'The breakdown appears with this turn’s first inference pass — the meter above is the run’s own reading.'}
        </p>
      )}
    </div>
  );
}
