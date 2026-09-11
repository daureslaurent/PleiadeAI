import { useState } from 'react';
import { Check, ChevronRight, ChevronsRight, Loader2, X } from 'lucide-react';
import type { Block } from '../store/stream';
import { describeTool } from '../lib/toolSummary';
import { ToolCard } from './ToolCall';

type ToolBlock = Extract<Block, { kind: 'tool' }>;

/**
 * The calls the model emitted in one assistant message, drawn as the one thing they were.
 *
 * A tool-call array *means* "these are independent" — the model cannot see any of their results
 * until every one of them comes back. The backend now runs the parallel-safe ones concurrently, so
 * printing them as three unrelated cards in a column would describe the old behaviour: it reads as
 * a sequence, and a reader counting seconds down the page would add up three durations that
 * overlapped.
 *
 * Hence the group card, and the bar next to each row. The bar is the only part that answers the
 * question the operator actually has when a batch is slow — *which* of these held it up — by
 * placing each call inside the batch's own wall clock rather than restating its duration. Three
 * 0.2s calls and one 1.8s call look identical as text; as bars, one of them obviously owns the
 * batch.
 *
 * Each row expands into the full tool card (already open, so a row is one click rather than two)
 * and, above it, the call's complete arguments — a `bash` command is a single truncated line in
 * every header in this app, and "what exactly did it run" is not answerable from that.
 */
export function ToolBatch({ blocks }: { blocks: ToolBlock[] }) {
  const [open, setOpen] = useState(true);
  const running = blocks.some((b) => b.status === 'running' || b.status === 'drafting');
  const failed = blocks.filter((b) => b.status === 'error').length;

  // The batch's own clock: from the first call that started to the last one that finished. A call
  // still running has no end yet, so the window stays open at `now` — the bars keep growing.
  const starts = blocks.map((b) => b.startedAt).filter((n): n is number => typeof n === 'number');
  const origin = starts.length ? Math.min(...starts) : null;
  const ends = blocks.map((b) =>
    typeof b.startedAt === 'number' && typeof b.durationMs === 'number' ? b.startedAt + b.durationMs : null,
  );
  const lastEnd = ends.filter((n): n is number => n !== null);
  const wall =
    origin === null ? 0 : Math.max(1, (running ? Date.now() : Math.max(...lastEnd, origin)) - origin);
  // What the batch would have cost run one after another — the saving, stated plainly.
  const work = blocks.reduce((sum, b) => sum + (b.durationMs ?? 0), 0);

  return (
    <div className="my-2 animate-fade-up overflow-hidden rounded-xl border border-accent/25 bg-accent/[0.04] text-xs backdrop-blur-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:raise-2"
      >
        <ChevronRight
          size={13}
          className={`shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <ChevronsRight size={13} className="shrink-0 text-accent" />
        <span className="shrink-0 font-medium text-slate-200">
          {blocks.length} tools in parallel
        </span>
        {!running && wall > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-slate-500">
            {fmt(wall)} wall
            {work > wall * 1.1 && <span className="text-slate-600"> · {fmt(work)} of work</span>}
          </span>
        )}
        {!open && (
          // Collapsed, the header has to carry what the rows were: a long turn folds to one line
          // each and stays scannable.
          <span className="min-w-0 truncate font-mono text-[10px] text-slate-600">
            {blocks.map((b) => b.tool).join(' · ')}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {running ? (
            <Loader2 size={12} className="animate-spin text-slate-500" />
          ) : failed ? (
            <span className="flex items-center gap-1 text-red-400">
              <X size={12} />
              {failed}
            </span>
          ) : (
            <Check size={12} className="text-emerald-400/70" />
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-accent/15">
          {blocks.map((b) => (
            <BatchRow key={b.callId} block={b} origin={origin} wall={wall} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One call of the batch: summary line, its slice of the batch's clock, and the full call on demand. */
function BatchRow({
  block,
  origin,
  wall,
}: {
  block: ToolBlock;
  origin: number | null;
  wall: number;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, value, title } = describeTool(block.tool, block.args ?? {}, block.result, block.status);
  const running = block.status === 'running' || block.status === 'drafting';

  // Where this call sits inside the batch's window, as percentages. A bar is never thinner than a
  // sliver: a 20ms call in a 4-minute batch must still be visible as *something* that ran.
  const offset =
    origin !== null && typeof block.startedAt === 'number' && wall > 0
      ? Math.min(99, ((block.startedAt - origin) / wall) * 100)
      : 0;
  const width =
    wall > 0 && typeof block.durationMs === 'number'
      ? Math.max(1.5, Math.min(100 - offset, (block.durationMs / wall) * 100))
      : null;

  return (
    <div className="border-b border-accent/10 last:border-b-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 py-1 pl-2 pr-3 text-left transition-colors hover:raise-1"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 text-slate-600 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <Icon size={12} className="shrink-0 text-accent" />
        <span className="shrink-0 font-mono text-[11px] text-slate-300">{block.tool}</span>
        <span
          title={title ?? value}
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500"
        >
          {value}
        </span>

        {/* The waterfall: this call's span within the batch, not merely its length. */}
        <span className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full well sm:block">
          <span
            className={`block h-full rounded-full ${
              running
                ? 'animate-pulse bg-accent/40'
                : block.status === 'error'
                  ? 'bg-red-400/60'
                  : 'bg-accent/60'
            }`}
            style={
              running
                ? { marginLeft: `${offset}%`, width: `${Math.max(6, 100 - offset)}%` }
                : { marginLeft: `${offset}%`, width: `${width ?? 100}%` }
            }
          />
        </span>

        <span className="w-10 shrink-0 text-right font-mono text-[10px] text-slate-600">
          {typeof block.durationMs === 'number' ? fmt(block.durationMs) : ''}
        </span>
        {running ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-slate-500" />
        ) : block.status === 'error' ? (
          <X size={11} className="shrink-0 text-red-400" />
        ) : (
          <Check size={11} className="shrink-0 text-emerald-400/70" />
        )}
      </button>

      {open && (
        <div className="px-2 pb-2">
          <ToolInput args={block.args} />
          <ToolCard block={block} defaultOpen />
        </div>
      )}
    </div>
  );
}

/**
 * The call's arguments, in full.
 *
 * Every header in this app truncates its call to one line, which is right for scanning and useless
 * the moment you want to know what a `bash` call actually ran — the interesting part of a long
 * command is exactly the part the ellipsis eats. So: the primary string argument verbatim in a
 * scrollable pre, and everything else as JSON beneath it. Nothing here is shortened.
 */
export function ToolInput({ args }: { args?: Record<string, unknown> }) {
  const entries = Object.entries(args ?? {});
  if (!entries.length) return null;
  // `command`, `query`, `body`… — the one argument that *is* the call, shown as text rather than as
  // a quoted JSON string with `\n` in it.
  const primaryKey = ['command', 'query', 'body', 'content', 'text', 'prompt', 'pattern'].find(
    (k) => typeof args?.[k] === 'string' && (args[k] as string).length > 0,
  );
  const primary = primaryKey ? String(args?.[primaryKey]) : null;
  const rest = primaryKey ? entries.filter(([k]) => k !== primaryKey) : entries;

  return (
    <div className="mb-1 overflow-hidden rounded-lg border hairline well">
      <div className="border-b hairline px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-slate-500">
        input
      </div>
      {primary !== null && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-slate-300">
          {primary}
        </pre>
      )}
      {rest.length > 0 && (
        <pre
          className={`max-h-40 overflow-auto whitespace-pre-wrap px-2 py-1.5 font-mono text-[10px] text-slate-400 ${
            primary !== null ? 'border-t hairline' : ''
          }`}
        >
          {JSON.stringify(Object.fromEntries(rest), null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Compact duration: sub-second in ms, then seconds, then minutes. */
function fmt(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`;
}
