import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  AudioLines,
  Clapperboard,
  Film,
  ImagePlus,
  Pencil,
  Plus,
  Search,
} from 'lucide-react';
import { Input, Toggle } from '../../components/ui';
import { mediaApi, type MediaWorkflow, type WorkflowKind } from '../../lib/api';

export const KIND_ICON: Record<WorkflowKind, typeof ImagePlus> = {
  image: ImagePlus,
  video: Clapperboard,
  audio: AudioLines,
  edit: Pencil,
  video_edit: Film,
};

const FILTERS: ('all' | WorkflowKind)[] = ['all', 'image', 'video', 'audio', 'edit', 'video_edit'];

function secs(ms: number): string {
  if (!ms) return 'untimed';
  return ms >= 60_000 ? `~${Math.round(ms / 60_000)}m` : `~${(ms / 1000).toFixed(0)}s`;
}

/**
 * The workflow library.
 *
 * Each card leads with the two things that decide whether a workflow is usable: how much of it the app
 * can actually drive (the bound meter), and whether its last validation failed. A name and a node count
 * never told anyone that.
 */
export function WorkflowRail({
  workflows,
  selectedId,
  onSelect,
  onAdd,
  onChanged,
}: {
  workflows: MediaWorkflow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | WorkflowKind>('all');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workflows.filter(
      (w) => (filter === 'all' || w.kind === filter) && (!q || w.name.toLowerCase().includes(q)),
    );
  }, [workflows, query, filter]);

  return (
    <aside className="glass flex w-72 shrink-0 flex-col border-r">
      <button
        onClick={onAdd}
        className="m-2 flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/[0.12] py-2 text-sm text-slate-400 transition-colors hover:border-accent/50 hover:bg-accent/[0.06] hover:text-accent active:scale-95"
      >
        <Plus size={15} /> Add workflow
      </button>

      <div className="space-y-1.5 px-2 pb-2">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-600" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="pl-7 text-xs"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                filter === f ? 'bg-accent/15 text-accent' : 'text-slate-500 hover:bg-white/[0.05]'
              }`}
            >
              {f === 'all' ? 'all' : f}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-auto px-2 pb-2">
        {shown.length === 0 && (
          <div className="px-2 py-6 text-center text-[11px] text-slate-600">
            {workflows.length === 0 ? 'Nothing imported yet.' : 'No workflow matches.'}
          </div>
        )}
        {shown.map((w) => (
          <WorkflowCard
            key={w.id}
            workflow={w}
            active={w.id === selectedId}
            onSelect={() => onSelect(w.id)}
            onChanged={onChanged}
          />
        ))}
      </div>
    </aside>
  );
}

function WorkflowCard({
  workflow,
  active,
  onSelect,
  onChanged,
}: {
  workflow: MediaWorkflow;
  active: boolean;
  onSelect: () => void;
  onChanged: () => Promise<void>;
}) {
  const Icon = KIND_ICON[workflow.kind] ?? ImagePlus;
  const total = workflow.bound.length + workflow.unbound.length;
  const ratio = total === 0 ? 1 : workflow.bound.length / total;

  return (
    <div
      className={`rounded-xl px-2.5 py-2 transition-colors ${
        active
          ? 'bg-accent/15 shadow-[inset_2px_0_0_0_rgba(59,130,246,0.7)]'
          : 'bg-black/20 hover:bg-white/[0.05]'
      } ${workflow.enabled ? '' : 'opacity-55'}`}
    >
      <div className="flex items-center gap-2">
        <Icon size={13} className={`shrink-0 ${active ? 'text-accent' : 'text-slate-400'}`} />
        <button onClick={onSelect} className="min-w-0 flex-1 text-left">
          <div className={`truncate text-xs ${active ? 'text-accent' : 'text-slate-200'}`}>{workflow.name}</div>
          <div className="truncate text-[10px] text-slate-500">
            {workflow.kind} · {workflow.node_count} nodes · {secs(workflow.avg_duration_ms)}
          </div>
        </button>
        {workflow.last_validation_error && (
          <span className="shrink-0" title={workflow.last_validation_error}>
            <AlertTriangle size={12} className="text-amber-400" />
          </span>
        )}
        <Toggle
          checked={workflow.enabled}
          onChange={async (v) => {
            await mediaApi.update(workflow.id, { enabled: v });
            await onChanged();
          }}
        />
      </div>

      {/* How much of the workflow the app can drive. Amber whenever something the tool sends would be
          silently dropped. */}
      <div className="mt-1.5 flex items-center gap-1.5" title={
        workflow.unbound.length > 0 ? `Unbound: ${workflow.unbound.join(', ')}` : 'Every expected parameter is bound'
      }>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
          <div
            className={`h-full transition-[width] ${ratio === 1 ? 'bg-emerald-500/70' : 'bg-amber-500/70'}`}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
        <span className={`shrink-0 text-[9px] ${ratio === 1 ? 'text-slate-600' : 'text-amber-400'}`}>
          {workflow.bound.length}/{total} mapped
        </span>
      </div>
    </div>
  );
}
