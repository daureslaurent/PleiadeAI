import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { FlowNodeType, PortType } from '../../lib/api';
import { GROUP_COLORS, GROUP_LABELS, PORT_COLORS, PORT_LABELS } from './portStyle';

const GROUP_ORDER = ['io', 'agent', 'media', 'tool', 'control'];

/**
 * The node palette + port-type legend.
 *
 * Built entirely from `GET /api/flows/node-types`, so it lists exactly what the backend can execute —
 * there is no client-side catalogue that can drift out of date with the runner.
 */
export function NodePalette({
  nodeTypes,
  onAdd,
}: {
  nodeTypes: FlowNodeType[];
  onAdd: (type: FlowNodeType) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const grouped = useMemo(() => {
    const map = new Map<string, FlowNodeType[]>();
    for (const type of nodeTypes) {
      map.set(type.group, [...(map.get(type.group) ?? []), type]);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [nodeTypes]);

  const toggle = (group: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {grouped.map(([group, types]) => (
          <div key={group}>
            <button
              onClick={() => toggle(group)}
              className="mb-1.5 flex w-full items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500 transition-colors hover:text-slate-300"
            >
              {collapsed.has(group) ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: GROUP_COLORS[group] }} />
              {GROUP_LABELS[group] ?? group}
            </button>
            {!collapsed.has(group) && (
              <div className="space-y-1">
                {types.map((type) => (
                  <button
                    key={type.type}
                    onClick={() => onAdd(type)}
                    title={type.description}
                    className="group flex w-full items-center gap-2 rounded-md border border-white/[0.06] bg-black/25 px-2.5 py-1.5 text-left text-xs text-slate-300 transition-colors hover:border-accent/40 hover:bg-accent/[0.07] hover:text-accent"
                  >
                    <span className="truncate">{type.label}</span>
                    <Plus size={12} className="ml-auto shrink-0 text-slate-600 group-hover:text-accent" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-white/[0.06] p-3">
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Link types
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {(Object.keys(PORT_COLORS) as PortType[]).map((type) => (
            <span key={type} className="flex items-center gap-1 text-[10px] text-slate-500">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: PORT_COLORS[type] }} />
              {PORT_LABELS[type]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
