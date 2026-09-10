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
 * **Usage** — where this agent's context window actually goes.
 *
 * The Prompt tab replays the conversation message by message; this one asks the question that
 * message list can't answer: *which part of the agent's configuration is eating the window*. The
 * backend cuts the assembled system message back into the modules it was glued from, sizes the tool
 * schemas (billed on every call, present in no message) and folds the conversation into role rows —
 * a 15%-of-window `AGENTS.md` is visible as a thing you could go and shorten.
 *
 * It reads the **latest** captured inference call of the session and re-reads when a turn finishes
 * streaming; while one is in flight, `useLiveUsageGuess` re-estimates the same shape every render off
 * the live stream state so the bar keeps moving instead of sitting frozen until the turn settles.
 *
 * That re-read is a short *poll*, not a single fetch: a capture is persisted fire-and-forget off
 * `llama:call_end`, so the instant streaming stops the just-finished call is usually not in Mongo
 * yet. One fetch there reads the state from *before* the turn — nothing at all on a session's first
 * turn — which is how the tab used to go blank exactly when it finally had something exact to show.
 * The poll stops on the first record newer than the one already on screen, and a fetch that comes
 * back empty or fails leaves the last good breakdown up rather than clearing it.
 */
export function PromptUsagePanel({ sessionId, agent }: Props) {
  const streaming = useStream((s) => s.streaming);
  const [call, setCall] = useState<LlamaCallRecord | null>(null);
  const [usage, setUsage] = useState<PromptUsageBreakdown | null>(null);
  const [loading, setLoading] = useState(false);

  /** The call currently on screen — read by the poll without making it a render dependency. */
  const shownIdRef = useRef<string | null>(null);

  /**
   * Fetch the session's latest capture and size it. Returns whether it found one *newer* than
   * `knownId`, which is what lets the post-turn poll stop as soon as the new record lands.
   */
  const load = useCallback(
    async (knownId?: string | null): Promise<boolean> => {
      if (!sessionId) return false;
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
        shownIdRef.current = latest.id;
        setCall(latest);
        setUsage(breakdown);
        return true;
      } catch {
        return false;
      } finally {
        setLoading(false);
      }
    },
    [sessionId, agent?._id],
  );

  // Switching sessions is the one time the panel must forget: another conversation's window is not
  // a stale view of this one, it's the wrong answer.
  useEffect(() => {
    shownIdRef.current = null;
    setCall(null);
    setUsage(null);
  }, [sessionId]);

  // Initial read, and the post-turn poll — the capture is written fire-and-forget after the stream
  // ends, so give it a few tries with a widening gap before settling for what's already shown.
  useEffect(() => {
    if (streaming || !sessionId) return;
    let cancelled = false;
    const known = shownIdRef.current;
    void (async () => {
      for (const wait of [0, 400, 1000, 2000, 4000]) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        if (cancelled) return;
        if (await load(known)) return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [streaming, sessionId, load]);

  const guess = useLiveUsageGuess(usage, streaming);
  const isGuess = streaming && guess !== null;
  const shown = isGuess ? guess : usage;

  const total = shown?.total ?? shown?.sum ?? call?.usage?.promptTokens ?? null;
  const windowSize = shown?.contextWindow ?? 0;
  const fill = windowSize > 0 && total !== null ? total / windowSize : 0;
  const partCount = useMemo(
    () => (shown ? shown.moduleGroups.length + shown.segments.filter((s) => s.kind !== 'module').length : 0),
    [shown],
  );

  if (!sessionId || (!call && !loading)) {
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
          <span
            className={`ml-auto font-mono text-[11px] ${
              fill > 0.8 ? 'text-red-400' : fill > 0.5 ? 'text-amber-400' : 'text-slate-400'
            }`}
          >
            {windowSize > 0 ? `${Math.round(fill * 100)}% of window` : ''}
          </span>
          <button
            onClick={() => void load()}
            title="Recompute"
            className="rounded p-1 text-slate-500 transition-colors hover:raise-2 hover:text-slate-300"
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
      {shown ? <UsageDetailList breakdown={shown} /> : null}
    </div>
  );
}
