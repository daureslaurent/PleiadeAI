import { useCallback, useEffect, useMemo, useState } from 'react';
import { Blocks, Hash, PieChart, RefreshCw } from 'lucide-react';
import {
  llmDebugApi,
  type Agent,
  type LlamaCallRecord,
  type PromptUsageBreakdown,
  type PromptUsageSegment,
} from '../../lib/api';
import { useStream } from '../../store/stream';

/**
 * Colour per known part of the prompt. Written out in full because Tailwind scans source for literal
 * class names — a computed `bg-${x}-400` would never make it into the stylesheet. Every value is a
 * themed ramp step, so a theme that repaints its palette repaints this chart with it.
 */
const SEGMENT_COLOR: Record<string, string> = {
  system_prompt: 'bg-accent',
  injected_system: 'bg-accent/60',
  tool_schemas: 'bg-reasoning',
  memory: 'bg-indigo-400',
  agents_md: 'bg-amber-400',
  house_rules: 'bg-amber-300',
  notebook: 'bg-rose-400',
  task_list: 'bg-rose-300',
  auto_loop: 'bg-rose-200',
  environment: 'bg-slate-400',
  local_parameters: 'bg-slate-500',
  orchestration: 'bg-slate-300',
  tool_use: 'bg-slate-200',
  active_modes: 'bg-indigo-300',
  user: 'bg-sky-400',
  assistant: 'bg-emerald-400',
  tool_results: 'bg-emerald-300',
};
/** Unknown blocks — a future prompt module, a hand-rolled `## ` heading — cycle through these. */
const FALLBACK_COLORS = ['bg-indigo-500', 'bg-sky-500', 'bg-rose-500', 'bg-amber-500'];

function colorFor(id: string, index: number): string {
  return SEGMENT_COLOR[id] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]!;
}

const GROUP_LABEL: Record<string, string> = {
  system: 'System prompt',
  tools: 'Toolset',
  conversation: 'Conversation',
};

interface Props {
  sessionId: string | null;
  agent: Agent | null;
}

/**
 * **Usage** — where this agent's context window actually goes.
 *
 * The Prompt tab replays the conversation message by message; this one asks the question that
 * message list can't answer: *which part of the agent's configuration is eating the window*. The
 * backend cuts the assembled system message back into the `jit-builder` blocks it was glued from,
 * sizes the tool schemas (billed on every call, present in no message) and folds the conversation
 * into role rows, so a 15%-of-window `AGENTS.md` is visible as a thing you could go and shorten.
 *
 * It reads the **latest** captured inference call of the session — the prompt as the model has it
 * right now — and re-reads when a turn finishes streaming.
 */
export function PromptUsagePanel({ sessionId, agent }: Props) {
  const streaming = useStream((s) => s.streaming);
  const [call, setCall] = useState<LlamaCallRecord | null>(null);
  const [usage, setUsage] = useState<PromptUsageBreakdown | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) {
      setCall(null);
      setUsage(null);
      return;
    }
    setLoading(true);
    try {
      const rows = await llmDebugApi.bySession(sessionId, 12);
      // The last pass carries the fullest context — that's the window the next turn starts from.
      const latest = rows.at(-1) ?? null;
      setCall(latest);
      if (!latest) {
        setUsage(null);
        return;
      }
      setUsage(
        await llmDebugApi.usageBreakdown(
          latest.request.messages ?? [],
          latest.tools ?? undefined,
          agent?._id ?? null,
        ),
      );
    } catch {
      setUsage(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId, agent?._id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Captures are persisted at call end, so a finished turn is when there is something new to read.
  useEffect(() => {
    if (!streaming) void load();
  }, [streaming, load]);

  const segments = useMemo(
    () => (usage?.segments ?? []).filter((s) => (s.tokens ?? 0) > 0),
    [usage],
  );
  const sum = usage?.sum ?? 0;
  // The templated total includes the chat template's own scaffolding, which belongs to no segment.
  // Charting against the sum keeps the shares honest; the window meter uses the real total.
  const total = usage?.total ?? call?.usage?.promptTokens ?? null;
  const windowSize = usage?.contextWindow ?? 0;
  const fill = windowSize > 0 && total !== null ? total / windowSize : 0;

  const groups = useMemo(() => {
    const out = new Map<string, { tokens: number; segments: PromptUsageSegment[] }>();
    for (const s of segments) {
      const g = out.get(s.group) ?? { tokens: 0, segments: [] };
      g.tokens += s.tokens ?? 0;
      g.segments.push(s);
      out.set(s.group, g);
    }
    return [...out.entries()];
  }, [segments]);

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

        {/* The stacked bar: every part of the prompt in proportion, trailing into the free window. */}
        <div className="mt-2 flex h-6 w-full overflow-hidden rounded-md well">
          {segments.map((s, i) => {
            const width = windowSize > 0 ? ((s.tokens ?? 0) / windowSize) * 100 : sum > 0 ? ((s.tokens ?? 0) / sum) * 100 : 0;
            return (
              <div
                key={s.id}
                title={`${s.label} — ${(s.tokens ?? 0).toLocaleString()} tok`}
                className={colorFor(s.id, i)}
                style={{ width: `${width}%` }}
              />
            );
          })}
        </div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-slate-600">
          <span className="truncate">{call?.model ?? ''}</span>
          {call?.agentName && <span className="truncate text-slate-500">{call.agentName}</span>}
          <span className="ml-auto flex items-center gap-1">
            <Hash size={9} />
            {sum.toLocaleString()} in {segments.length} parts
          </span>
        </div>
      </div>

      {/* The list: every type of prompt, its tokens and its share. */}
      <div className="px-3 py-2">
        {groups.map(([group, g]) => (
          <div key={group} className="mb-3 last:mb-0">
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                {GROUP_LABEL[group] ?? group}
              </span>
              <span className="ml-auto font-mono text-[10px] text-slate-500">
                {g.tokens.toLocaleString()} tok
              </span>
            </div>
            {g.segments.map((s) => (
              <SegmentRow
                key={s.id}
                segment={s}
                color={colorFor(s.id, segments.indexOf(s))}
                share={sum > 0 ? (s.tokens ?? 0) / sum : 0}
              />
            ))}
          </div>
        ))}
        {!segments.length && !loading && (
          <p className="py-6 text-center text-[11px] text-slate-500">
            The inference host didn't return token counts for this call.
          </p>
        )}
      </div>

      {/* Modules — the prompt's shape as it was actually assembled. Titles only: the module system
          (enable/disable/reorder per agent) lands later, and this is the surface it lands on. */}
      <div className="border-t hairline px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <Blocks size={12} className="text-slate-500" />
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Modules</span>
          <span className="ml-auto text-[10px] text-slate-600">{usage?.modules.length ?? 0}</span>
        </div>
        {usage?.modules.length ? (
          <ul className="space-y-0.5">
            {usage.modules.map((m, i) => (
              <li
                key={`${m}-${i}`}
                className="flex items-center gap-2 rounded px-1.5 py-1 text-[11px] text-slate-400"
              >
                <span className="font-mono text-[10px] text-slate-600">{i + 1}</span>
                <span className="truncate">{m}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-slate-600">No named blocks in this prompt.</p>
        )}
      </div>
    </div>
  );
}

/** One row of the breakdown: colour key, name, share bar, tokens and percent. */
function SegmentRow({
  segment,
  color,
  share,
}: {
  segment: PromptUsageSegment;
  color: string;
  share: number;
}) {
  return (
    <div className="flex items-center gap-2 rounded px-1.5 py-1 hover:raise-1">
      <span className={`h-2 w-2 shrink-0 rounded-sm ${color}`} />
      <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">
        {segment.label}
        {segment.count > 1 && (
          <span className="ml-1 font-mono text-[10px] text-slate-600">×{segment.count}</span>
        )}
      </span>
      <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full raise-2">
        <span className={`block h-full ${color}`} style={{ width: `${Math.min(100, share * 100)}%` }} />
      </span>
      <span className="w-14 shrink-0 text-right font-mono text-[10px] text-slate-400">
        {(segment.tokens ?? 0).toLocaleString()}
      </span>
      <span className="w-9 shrink-0 text-right font-mono text-[10px] text-slate-500">
        {(share * 100).toFixed(share < 0.01 ? 1 : 0)}%
      </span>
    </div>
  );
}
