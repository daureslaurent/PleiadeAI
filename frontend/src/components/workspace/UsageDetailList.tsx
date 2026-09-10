import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { PromptUsageBreakdown, PromptUsageSegment } from '../../lib/api';
import { categoryColor, moduleColor } from './UsageBar';

const KIND_LABEL: Record<string, string> = {
  system_prompt: 'Operator prompt',
  tools: 'Toolset',
  history: 'Conversation',
  reasoning: 'Reasoning (live estimate)',
};

interface Row {
  key: string;
  label: string;
  tokens: number;
  color: string;
  children: PromptUsageSegment[];
}

/** One row per rendered module, one per non-empty non-module category, biggest concerns first-ish (registry/segment order). */
function buildRows(breakdown: PromptUsageBreakdown): Row[] {
  const moduleRows: Row[] = breakdown.moduleGroups
    .filter((g) => g.tokens > 0)
    .map((g) => ({
      key: `module:${g.moduleId}`,
      label: g.moduleName,
      tokens: g.tokens,
      color: moduleColor(g, breakdown.moduleGroups),
      children: g.segments,
    }));

  const byKind = new Map<string, PromptUsageSegment[]>();
  for (const s of breakdown.segments) {
    if (s.kind === 'module') continue;
    const list = byKind.get(s.kind) ?? [];
    list.push(s);
    byKind.set(s.kind, list);
  }
  const categoryRows: Row[] = [];
  for (const [kind, segs] of byKind) {
    const tokens = segs.reduce((a, s) => a + (s.tokens ?? 0), 0);
    if (!tokens) continue;
    categoryRows.push({
      key: `cat:${kind}`,
      label: KIND_LABEL[kind] ?? kind,
      tokens,
      color: categoryColor(segs[0]!.id),
      children: segs,
    });
  }
  return [...moduleRows, ...categoryRows];
}

interface Props {
  breakdown: PromptUsageBreakdown;
}

/** Per module/category rows, expandable into the individual blocks or message types that fed them. */
export function UsageDetailList({ breakdown }: Props) {
  const rows = buildRows(breakdown);
  const total = breakdown.sum || 1;
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!rows.length) {
    return (
      <p className="py-6 text-center text-[11px] text-slate-500">
        The inference host didn't return token counts for this call.
      </p>
    );
  }

  return (
    <div className="px-3 py-2">
      {rows.map((row) => {
        const isOpen = open.has(row.key);
        const share = row.tokens / total;
        const expandable = row.children.length > 1;
        return (
          <div key={row.key} className="mb-0.5 last:mb-0">
            <button
              type="button"
              onClick={() => expandable && toggle(row.key)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:raise-1"
            >
              {expandable ? (
                <ChevronRight
                  size={10}
                  className={`shrink-0 text-slate-600 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                />
              ) : (
                <span className="w-[10px] shrink-0" />
              )}
              <span className={`h-2 w-2 shrink-0 rounded-sm ${row.color}`} />
              <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">{row.label}</span>
              <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full raise-2">
                <span
                  className={`block h-full ${row.color}`}
                  style={{ width: `${Math.min(100, share * 100)}%` }}
                />
              </span>
              <span className="w-14 shrink-0 text-right font-mono text-[10px] text-slate-400">
                {row.tokens.toLocaleString()}
              </span>
              <span className="w-9 shrink-0 text-right font-mono text-[10px] text-slate-500">
                {(share * 100).toFixed(share < 0.01 ? 1 : 0)}%
              </span>
            </button>
            {isOpen && (
              <div className="ml-4 border-l hairline pl-2">
                {row.children.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 rounded px-1.5 py-0.5">
                    <span className="min-w-0 flex-1 truncate text-[10px] text-slate-500">
                      {s.label}
                      {s.count > 1 && (
                        <span className="ml-1 font-mono text-[9px] text-slate-600">×{s.count}</span>
                      )}
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono text-[10px] text-slate-500">
                      {(s.tokens ?? 0).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
