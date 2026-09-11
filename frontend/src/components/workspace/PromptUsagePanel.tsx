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

/** Backoff between attempts at reading a capture that is written fire-and-forget after the turn. */
const POLL_WAITS = [0, 400, 1000, 2000, 4000, 8000];

/**
 * **Usage** — where this agent's context window actually goes.
 *
 * The Prompt tab replays the conversation message by message; this one asks the question that
 * message list can't answer: *which part of the agent's configuration is eating the window*. The
 * backend cuts the assembled system message back into the modules it was glued from, sizes the tool
 * schemas (billed on every call, present in no message) and folds the conversation into role rows —
 * a 15%-of-window `AGENTS.md` is visible as a thing you could go and shorten.
 *
 * **Two sources, and the panel never has neither.** The exact breakdown comes from re-sizing the
 * session's latest *captured* inference call; the headline meter comes from the `context_usage`
 * events the run already streams (`store/stream.ts`), which are exact prompt-token counts from the
 * server and need no fetch at all. So a turn in flight moves the meter from its first reading —
 * including on a session's very first turn, where there is no capture to fetch yet and the panel
 * used to sit on "no inference call captured".
 *
 * **Nothing here is gated on the turn being over.** The fetch is triggered by *anything* that says
 * the session moved — mount, session change, a settled `context_usage`, a new turn, the streaming
 * flag dropping — and each trigger retries from scratch, so one failed read (or one stale
 * `streaming` flag) can't wedge the tab until a reload. It is a short *poll*, not a single fetch: a
 * capture is persisted fire-and-forget off `llama:call_end`, so the instant streaming stops the
 * just-finished call is usually not in Mongo yet.
 *
 * **It never clears.** A fetch that fails or comes back empty leaves the last good breakdown up
 * (flagged stale) rather than blanking — a call that ended is still the truest thing we know about
 * this window, and an empty panel is strictly less informative than a second-old one.
 */
export function PromptUsagePanel({ sessionId, agent }: Props) {
  const streaming = useStream((s) => s.streaming);
  // The run's own readings: `liveContext` is this turn's climbing prompt total, `contextUsage` the
  // settled one. Either lets the meter render with no capture in hand at all.
  const liveContext = useStream((s) => s.liveContext);
  const settledContext = useStream((s) => s.contextUsage);
  // Any of these changing means "the session moved, go look for a newer capture".
  const turnCount = useStream((s) => s.turns.length);

  const [call, setCall] = useState<LlamaCallRecord | null>(null);
  const [usage, setUsage] = useState<PromptUsageBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);

  /** The call currently on screen — read by the poll without making it a render dependency. */
  const shownIdRef = useRef<string | null>(null);
  /** Bumped on every session change so a slow read can't paint the previous conversation's window. */
  const genRef = useRef(0);

  /**
   * Fetch the session's latest capture and size it. Returns whether it found one *newer* than
   * `knownId`, which is what lets the post-turn poll stop as soon as the new record lands.
   */
  const load = useCallback(
    async (knownId?: string | null): Promise<boolean> => {
      if (!sessionId) return false;
      const gen = genRef.current;
      setLoading(true);
      try {
        const rows = await llmDebugApi.bySession(sessionId, 12);
        // The last pass carries the fullest context — that's the window the next turn starts from.
        const latest = rows.at(-1) ?? null;
        if (!latest || (knownId !== undefined && latest.id === knownId)) return false;
        const breakdown = await llmDebugApi.usageBreakdown(
          latest.request.messages ?? [],
          latest.tools ?? undefined,
          agent?._id ?? null,
        );
        // The operator switched conversation while this was in flight: drop it on the floor rather
        // than paint another session's window over theirs.
        if (gen !== genRef.current) return false;
        shownIdRef.current = latest.id;
        setCall(latest);
        setUsage(breakdown);
        setStale(false);
        return true;
      } catch {
        // Keep whatever is on screen; the next trigger (or the refresh button) tries again.
        if (gen === genRef.current) setStale(true);
        return false;
      } finally {
        if (gen === genRef.current) setLoading(false);
      }
    },
    [sessionId, agent?._id],
  );

  // Switching sessions is the one time the panel must forget: another conversation's window is not
  // a stale view of this one, it's the wrong answer.
  useEffect(() => {
    genRef.current += 1;
    shownIdRef.current = null;
    setCall(null);
    setUsage(null);
    setStale(false);
  }, [sessionId]);

  // The read, on every signal that the session moved — deliberately *not* gated on `streaming`.
  // Mounting mid-turn still fetches: the last completed call is exactly the baseline the live
  // estimate re-scales, so opening the tab during a turn shows a moving bar instead of nothing.
  // The widening poll covers the capture being written fire-and-forget after the stream ends.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const known = shownIdRef.current;
    void (async () => {
      for (const wait of POLL_WAITS) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        if (cancelled) return;
        if (await load(known)) return;
      }
    })();
    return () => {
      cancelled = true;
    };
    // `settledContext` identity changes once per finished turn — the earliest reliable "this turn
    // produced a call" signal, and it arrives even if the `streaming` flag never flips back.
  }, [sessionId, load, streaming, turnCount, settledContext]);

  const guess = useLiveUsageGuess(usage, streaming);
  const isGuess = streaming && guess !== null;
  const shown = isGuess ? guess : usage;

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

  // Empty only when there is genuinely nothing to say: no capture, no breakdown, no reading from the
  // live run, and no read in flight. A finished call stays on screen; a live turn shows its meter.
  if (!sessionId || (!call && !shown && !reading && !loading)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <PieChart size={26} className="text-slate-600" />
        <p className="text-xs text-slate-500">
          {sessionId
            ? 'No inference call captured yet. Send a message to see where the context goes.'
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
          {isGuess && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-slate-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              estimated
            </span>
          )}
          {!isGuess && streaming && reading && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-slate-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              live
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
            title={stale ? "Couldn't size the last call — retry" : 'Recompute'}
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
          Kept up while a refresh or the post-turn poll runs: a list that blanks on every attempt is
          worse than one that's a second stale, and the spinner already says a read is in flight. */}
      {shown ? (
        <UsageDetailList breakdown={shown} />
      ) : (
        <p className="px-3 py-3 text-[11px] text-slate-500">
          {loading
            ? 'Sizing the last call…'
            : 'Breakdown appears once this turn’s call is captured — the meter above is the run’s own reading.'}
        </p>
      )}
    </div>
  );
}
