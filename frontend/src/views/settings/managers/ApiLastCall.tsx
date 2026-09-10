import { AlertTriangle, ArrowRight, FlaskConical } from 'lucide-react';
import { Dot, StatusBadge, type Tone } from '../../../components/ui';
import type { ApiLastCall as LastCall } from '../../../lib/api';

/**
 * How an API's most recent call went (Settings → APIs).
 *
 * The state that matters is three-way, not two: **never called** is not the same as **working**, and
 * an operator reading a page of green rows needs to know which of them are green because they
 * answered and which are green because nobody has asked. So an API with no `last_call` says so
 * rather than defaulting to healthy.
 *
 * Colour comes from the shared tone vocabulary (`Dot`/`StatusBadge`), whose emerald/amber/red ramps
 * are theme variables — Terminal renders "ok" as phosphor green and Paper darkens it to read on
 * cream, without this component knowing either exists.
 */

/** Compact relative age: the useful precision for "did this just break" is minutes, not seconds. */
export function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

export function lastCallTone(call: LastCall | null): Tone {
  if (!call) return 'idle';
  return call.ok ? 'ok' : 'error';
}

/** The dot shown on a collapsed row — the whole state in six pixels. */
export function LastCallDot({ call }: { call: LastCall | null }) {
  return (
    <Dot
      tone={lastCallTone(call)}
      title={
        call
          ? `${call.ok ? 'Last call succeeded' : 'Last call failed'} — ${call.operation || 'unknown operation'}, ${timeAgo(call.at)}`
          : 'Never called'
      }
    />
  );
}

/**
 * The full readout, shown when a row is expanded. A failure prints the agent's own error verbatim:
 * it is the same string the model was handed, so the operator debugs what the agent actually saw.
 */
export function ApiLastCallLine({ call }: { call: LastCall | null }) {
  if (!call) {
    return (
      <div className="flex items-center gap-2 rounded-lg hairline px-2 py-1.5">
        <Dot tone="idle" />
        <span className="text-[11px] text-slate-500">
          Never called. Run an operation’s Test below, or grant an agent the{' '}
          <code className="font-mono">api</code> tool.
        </span>
      </div>
    );
  }

  const tone = lastCallTone(call);
  return (
    <div className="space-y-1.5 rounded-lg hairline px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge tone={tone}>{call.ok ? 'ok' : 'failed'}</StatusBadge>
        {call.operation && <span className="font-mono text-[11px] text-slate-300">{call.operation}</span>}
        {call.status !== null && <span className="font-mono text-[10px] text-slate-500">HTTP {call.status}</span>}
        {call.duration_ms > 0 && <span className="font-mono text-[10px] text-slate-500">{call.duration_ms}ms</span>}
        <span className="text-[10px] text-slate-500">{timeAgo(call.at)}</span>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-slate-500">
          {call.via === 'test' ? (
            <>
              <FlaskConical size={10} /> your Test
            </>
          ) : (
            <>
              <ArrowRight size={10} /> {call.agent || 'an agent'}
            </>
          )}
        </span>
      </div>

      {!call.ok && call.error && (
        <p className="flex items-start gap-1.5 break-words font-mono text-[10px] leading-relaxed text-red-400">
          <AlertTriangle size={11} className="mt-px shrink-0" />
          <span className="min-w-0">{call.error}</span>
        </p>
      )}
    </div>
  );
}

/**
 * One line over the whole list: how many APIs are answering, how many are failing, how many have
 * never been asked. It is the answer to "is everything ok" without opening twenty rows.
 */
export function ApiHealthSummary({ calls }: { calls: (LastCall | null)[] }) {
  const failing = calls.filter((c) => c && !c.ok).length;
  const ok = calls.filter((c) => c?.ok).length;
  const untried = calls.filter((c) => !c).length;
  if (!calls.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl hairline raise-1 px-3 py-2 text-[11px]">
      {failing > 0 && (
        <span className="flex items-center gap-1.5 text-red-400">
          <Dot tone="error" /> {failing} failing
        </span>
      )}
      <span className="flex items-center gap-1.5 text-slate-400">
        <Dot tone="ok" /> {ok} answering
      </span>
      <span className="flex items-center gap-1.5 text-slate-500">
        <Dot tone="idle" /> {untried} never called
      </span>
      {failing === 0 && ok > 0 && (
        <span className="ml-auto text-[10px] text-slate-500">Every API that has been called is answering.</span>
      )}
    </div>
  );
}
