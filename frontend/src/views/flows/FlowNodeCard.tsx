import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Check, CircleDashed, Loader2, SkipForward } from 'lucide-react';
import type { FlowNodeStatus, FlowNodeType, PortSpec, PortType } from '../../lib/api';
import { GROUP_COLORS, portColor } from './portStyle';

/** Live run state overlaid on a node while a run is in flight. */
export interface NodeRunState {
  status: FlowNodeStatus;
  percent?: number | null;
  message?: string;
  /** Latest ComfyUI preview frame (data URL). */
  preview?: string;
  summary?: string;
  error?: string;
  iteration?: number;
}

export interface FlowNodeData extends Record<string, unknown> {
  nodeType: FlowNodeType | undefined;
  label: string;
  /** One line of the node's own config, so a card says what it *does*, not just what it is. */
  subtitle: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  run?: NodeRunState;
  issue?: 'error' | 'warning';
}

const STATUS_RING: Record<FlowNodeStatus, string> = {
  pending: 'ring-white/[0.08]',
  running: 'ring-accent/70',
  success: 'ring-emerald-500/50',
  error: 'ring-red-500/60',
  skipped: 'ring-white/[0.06]',
};

function StatusIcon({ status }: { status: FlowNodeStatus }) {
  if (status === 'running') return <Loader2 size={12} className="animate-spin text-accent" />;
  if (status === 'success') return <Check size={12} className="text-emerald-400" />;
  if (status === 'error') return <AlertTriangle size={12} className="text-red-400" />;
  if (status === 'skipped') return <SkipForward size={12} className="text-slate-600" />;
  return <CircleDashed size={12} className="text-slate-600" />;
}

/**
 * One node on the canvas.
 *
 * Ports are laid out vertically down each side and coloured by type, so the wiring reads as a
 * diagram rather than a pile of identical dots. While a run is live the same card carries its state:
 * ring colour for status, a progress bar, and — for a ComfyUI node — the preview frame itself, which
 * is the difference between "something is happening" and "*this* is happening".
 */
export const FlowNodeCard = memo(function FlowNodeCard({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const accent = GROUP_COLORS[d.nodeType?.group ?? 'io'] ?? GROUP_COLORS.io;
  const run = d.run;
  const ring = run ? STATUS_RING[run.status] : selected ? 'ring-accent/60' : 'ring-white/[0.08]';

  return (
    <div
      className={`min-w-[190px] max-w-[240px] rounded-xl bg-[#0d1424]/95 shadow-lg ring-1 backdrop-blur-sm transition-shadow ${ring} ${
        run?.status === 'skipped' ? 'opacity-45' : ''
      }`}
      style={{ borderTop: `2px solid ${accent}` }}
    >
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2">
        {run && <StatusIcon status={run.status} />}
        <span className="truncate text-xs font-medium text-slate-100">{d.label}</span>
        {run?.iteration !== undefined && (
          <span className="ml-auto shrink-0 rounded bg-white/[0.08] px-1 text-[9px] text-slate-400">
            #{run.iteration + 1}
          </span>
        )}
        {!run && d.issue && (
          <AlertTriangle
            size={11}
            className={`ml-auto shrink-0 ${d.issue === 'error' ? 'text-red-400' : 'text-amber-400'}`}
          />
        )}
      </div>

      {d.subtitle && (
        <div className="truncate px-2.5 pb-1.5 text-[10px] leading-tight text-slate-500">{d.subtitle}</div>
      )}

      {run?.preview && (
        <img
          src={run.preview}
          alt=""
          className="mx-2.5 mb-1.5 max-h-24 w-[calc(100%-1.25rem)] rounded object-cover"
        />
      )}

      {run?.status === 'running' && (
        <div className="px-2.5 pb-1.5">
          <div className="h-1 overflow-hidden rounded-full bg-white/[0.08]">
            <div
              className={`h-full bg-accent transition-[width] duration-300 ${
                run.percent == null ? 'animate-pulse w-1/3' : ''
              }`}
              style={run.percent == null ? undefined : { width: `${Math.max(2, run.percent)}%` }}
            />
          </div>
          {run.message && (
            <div className="mt-1 truncate text-[9px] text-slate-500">{run.message}</div>
          )}
        </div>
      )}

      {/* What the node actually produced. Without this a finished card goes blank and you have to
          open a panel to learn whether the step did anything at all. */}
      {run?.status === 'success' && run.summary && (
        <div className="mx-2.5 mb-1.5 line-clamp-3 rounded bg-white/[0.04] px-1.5 py-1 text-[9px] leading-tight text-slate-400">
          {run.summary}
        </div>
      )}

      {run?.error && (
        <div className="mx-2.5 mb-1.5 rounded bg-red-500/10 px-1.5 py-1 text-[9px] leading-tight text-red-300">
          {run.error}
        </div>
      )}

      <div className="flex justify-between gap-3 border-t border-white/[0.06] px-1 pb-1.5 pt-1.5">
        <div className="flex flex-col gap-1">
          {d.inputs.map((port, i) => (
            <PortRow key={port.name} port={port} side="target" index={i} />
          ))}
        </div>
        <div className="flex flex-col items-end gap-1">
          {d.outputs.map((port, i) => (
            <PortRow key={port.name} port={port} side="source" index={i} />
          ))}
        </div>
      </div>
    </div>
  );
});

function PortRow({ port, side, index }: { port: PortSpec; side: 'source' | 'target'; index: number }) {
  const color = portColor(port.types[0] as PortType);
  const isSource = side === 'source';
  return (
    <div className={`relative flex items-center gap-1 ${isSource ? 'flex-row-reverse' : ''}`}>
      <Handle
        id={port.name}
        type={isSource ? 'source' : 'target'}
        position={isSource ? Position.Right : Position.Left}
        // Positioned against this row rather than the node, so a handle always sits on its label.
        style={{
          position: 'absolute',
          [isSource ? 'right' : 'left']: -11,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 9,
          height: 9,
          background: color,
          border: `1px solid ${color}`,
          boxShadow: `0 0 0 2px rgba(13,20,36,0.95)`,
        }}
        data-port-type={port.types[0]}
        data-index={index}
      />
      <span className="px-1.5 text-[9px] text-slate-500">
        {port.name}
        {port.required && <span className="text-red-400">*</span>}
      </span>
    </div>
  );
}
