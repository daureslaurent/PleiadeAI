import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AudioLines, ChevronDown, Film, ImageIcon, Link2Off, Sparkles } from 'lucide-react';
import type { BindingMeta, WorkflowNode, WorkflowNodeInput } from '../../lib/api';
import { bindingPortColor, inputValueLabel, nodeRoleColor } from './bindingPorts';

/** Handle ids. Prefixed so a node input called `result` can't collide with the output handle. */
export const IN_HANDLE = (input: string) => `in:${input}`;
export const OUT_HANDLE = (slot: number) => `out:${slot}`;
export const RESULT_HANDLE = 'result';

const HANDLE_BASE = {
  width: 9,
  height: 9,
  border: '1px solid',
  boxShadow: '0 0 0 2px rgba(13,20,36,0.95)',
} as const;

// --- App inputs -----------------------------------------------------------------------------

export interface AppInputsData extends Record<string, unknown> {
  catalog: BindingMeta[];
  /** Keys currently wired to something, so a bound-but-irrelevant key still shows. */
  bound: Set<string>;
}

/**
 * The app half of the mapping: one port per logical parameter a tool or flow node can drive.
 *
 * Parameters the workflow's kind actually uses are listed openly; the rest fold away, because a
 * text-to-image graph has no business showing `video` and `audio 2` ports by default — that noise is
 * exactly what made the old sixteen-row editor unreadable.
 */
export const AppInputsNode = memo(function AppInputsNode({ data }: NodeProps) {
  const d = data as AppInputsData;
  const [showAll, setShowAll] = useState(false);

  const primary = d.catalog.filter((m) => m.expected || d.bound.has(m.key));
  const extra = d.catalog.filter((m) => !primary.includes(m));

  return (
    <div className="w-[210px] rounded-xl bg-[#0d1424]/95 shadow-lg ring-1 ring-accent/30 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-2.5 py-2">
        <Sparkles size={12} className="text-accent" />
        <span className="text-xs font-medium text-slate-100">App inputs</span>
      </div>
      <div className="py-1.5">
        {primary.map((meta) => (
          <ParamRow key={meta.key} meta={meta} bound={d.bound.has(meta.key)} />
        ))}
        {extra.length > 0 && (
          <>
            {showAll && extra.map((meta) => <ParamRow key={meta.key} meta={meta} bound={false} dim />)}
            <button
              onClick={() => setShowAll((v) => !v)}
              className="nodrag mt-0.5 flex w-full items-center gap-1 px-2.5 py-1 text-[9px] text-slate-500 transition-colors hover:text-slate-300"
            >
              <ChevronDown size={9} className={showAll ? 'rotate-180 transition-transform' : 'transition-transform'} />
              {showAll ? 'fewer' : `${extra.length} more parameters`}
            </button>
          </>
        )}
      </div>
    </div>
  );
});

function ParamRow({ meta, bound, dim = false }: { meta: BindingMeta; bound: boolean; dim?: boolean }) {
  const color = bindingPortColor(meta.port);
  return (
    <div
      className={`relative flex items-center justify-end gap-1.5 px-2.5 py-[3px] ${dim ? 'opacity-55' : ''}`}
      title={`${meta.description}\n\n${meta.source}`}
    >
      {meta.expected && !bound && (
        <span className="text-[8px] uppercase tracking-wide text-amber-400/80">unbound</span>
      )}
      <span className={`truncate text-[10px] ${bound ? 'text-slate-200' : 'text-slate-400'}`}>{meta.label}</span>
      <span className="font-mono text-[8px] text-slate-600">{meta.port}</span>
      <Handle
        id={meta.key}
        type="source"
        position={Position.Right}
        style={{
          ...HANDLE_BASE,
          position: 'absolute',
          right: -11,
          top: '50%',
          transform: 'translateY(-50%)',
          background: bound ? color : 'transparent',
          borderColor: color,
        }}
      />
    </div>
  );
}

// --- A workflow node ------------------------------------------------------------------------

export interface ComfyNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  /** input name → the logical parameter bound to it. */
  boundBy: Map<string, BindingMeta>;
  /** True when this node's files are the workflow's result. */
  isResult: boolean;
  onUnbind: (key: string) => void;
}

/**
 * One ComfyUI node.
 *
 * Every input is listed with the literal it currently holds, because that value is the evidence: the
 * operator recognises their own prompt, their own resolution, their own checkpoint, and that is how
 * they know node 42 is the one they meant. Tensor inputs get no handle at all — a binding there could
 * never take effect.
 */
export const ComfyNodeCard = memo(function ComfyNodeCard({ data, selected }: NodeProps) {
  const d = data as ComfyNodeData;
  const { node } = d;
  const accent = nodeRoleColor(node.class_type, d.isResult);
  const bindable = node.inputs.filter((i) => i.bindable);
  const linked = node.inputs.filter((i) => !i.bindable);

  return (
    <div
      className={`w-[230px] rounded-xl bg-[#0d1424]/95 shadow-lg ring-1 backdrop-blur-sm transition-shadow ${
        selected ? 'ring-accent/60' : d.boundBy.size > 0 ? 'ring-white/[0.16]' : 'ring-white/[0.08]'
      }`}
      style={{ borderTop: `2px solid ${accent}` }}
    >
      <div className="px-2.5 pb-1 pt-2">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-slate-100">{node.title}</span>
          <span className="ml-auto shrink-0 rounded bg-white/[0.06] px-1 font-mono text-[9px] text-slate-500">
            #{node.id}
          </span>
        </div>
        <div className="truncate font-mono text-[9px] text-slate-500">{node.class_type}</div>
      </div>

      <div className="border-t border-white/[0.06] py-1">
        {bindable.map((input) => (
          <InputRow key={input.name} input={input} meta={d.boundBy.get(input.name)} onUnbind={d.onUnbind} />
        ))}
        {bindable.length === 0 && (
          <div className="px-2.5 py-1 text-[9px] text-slate-600">nothing bindable here</div>
        )}
      </div>

      {/* Tensor inputs: shown so the wiring reads, but never a drop target. */}
      {linked.length > 0 && (
        <div className="border-t border-white/[0.06] py-1">
          {linked.map((input) => (
            <div key={input.name} className="relative px-2.5 py-[2px]">
              <Handle
                id={IN_HANDLE(input.name)}
                type="target"
                position={Position.Left}
                isConnectable={false}
                style={{
                  ...HANDLE_BASE,
                  position: 'absolute',
                  left: -11,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 6,
                  height: 6,
                  background: '#334155',
                  borderColor: '#475569',
                }}
              />
              <span className="text-[9px] text-slate-600">{input.name}</span>
            </div>
          ))}
        </div>
      )}

      {node.outputs.length > 0 && (
        <div className="flex flex-col items-end border-t border-white/[0.06] py-1">
          {node.outputs.map((output) => (
            <div key={output.slot} className="relative px-2.5 py-[2px]">
              <span className="font-mono text-[9px] text-slate-600">{output.name}</span>
              <Handle
                id={OUT_HANDLE(output.slot)}
                type="source"
                position={Position.Right}
                isConnectable={false}
                style={{
                  ...HANDLE_BASE,
                  position: 'absolute',
                  right: -11,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 6,
                  height: 6,
                  background: '#334155',
                  borderColor: '#475569',
                }}
              />
            </div>
          ))}
        </div>
      )}

      {/* The "this is the result" port. Only nodes that write files can carry it. */}
      {node.is_output && (
        <div className="relative flex items-center justify-end gap-1 border-t border-white/[0.06] px-2.5 py-1.5">
          <span className={`text-[9px] ${d.isResult ? 'text-emerald-400' : 'text-slate-600'}`}>
            {d.isResult ? 'result → app' : 'make result'}
          </span>
          <Handle
            id={RESULT_HANDLE}
            type="source"
            position={Position.Right}
            style={{
              ...HANDLE_BASE,
              position: 'absolute',
              right: -11,
              top: '50%',
              transform: 'translateY(-50%)',
              background: d.isResult ? '#34d399' : 'transparent',
              borderColor: '#34d399',
            }}
          />
        </div>
      )}
    </div>
  );
});

function InputRow({
  input,
  meta,
  onUnbind,
}: {
  input: WorkflowNodeInput;
  meta: BindingMeta | undefined;
  onUnbind: (key: string) => void;
}) {
  const color = meta ? bindingPortColor(meta.port) : '#475569';
  return (
    <div
      className={`group relative flex items-center gap-1.5 px-2.5 py-[3px] ${meta ? 'bg-white/[0.04]' : ''}`}
      title={input.tooltip}
    >
      <Handle
        id={IN_HANDLE(input.name)}
        type="target"
        position={Position.Left}
        style={{
          ...HANDLE_BASE,
          position: 'absolute',
          left: -11,
          top: '50%',
          transform: 'translateY(-50%)',
          background: meta ? color : 'transparent',
          borderColor: color,
        }}
      />
      <span className={`shrink-0 text-[10px] ${meta ? 'text-slate-200' : 'text-slate-400'}`}>{input.name}</span>
      {meta ? (
        <>
          <span
            className="ml-auto truncate rounded px-1 font-mono text-[9px]"
            style={{ color, background: `${color}1f` }}
          >
            {meta.key}
          </span>
          <button
            onClick={() => onUnbind(meta.key)}
            title={`Unbind ${meta.key}`}
            className="nodrag shrink-0 text-slate-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
          >
            <Link2Off size={10} />
          </button>
        </>
      ) : (
        <span className="ml-auto truncate font-mono text-[9px] text-slate-600">{inputValueLabel(input)}</span>
      )}
    </div>
  );
}

// --- App output -----------------------------------------------------------------------------

export interface AppOutputData extends Record<string, unknown> {
  outputKind: 'image' | 'video' | 'audio';
  /** False when no node has been named as the result — the run would have nothing to return. */
  connected: boolean;
}

const OUTPUT_ICON = { image: ImageIcon, video: Film, audio: AudioLines };

/** Where the workflow's files leave for the app: a session resource, and the tool's return value. */
export const AppOutputNode = memo(function AppOutputNode({ data }: NodeProps) {
  const d = data as AppOutputData;
  const Icon = OUTPUT_ICON[d.outputKind] ?? ImageIcon;
  return (
    <div
      className={`relative w-[170px] rounded-xl bg-[#0d1424]/95 px-2.5 py-2 shadow-lg ring-1 backdrop-blur-sm ${
        d.connected ? 'ring-emerald-500/30' : 'ring-amber-500/40'
      }`}
    >
      <Handle
        id={RESULT_HANDLE}
        type="target"
        position={Position.Left}
        style={{
          ...HANDLE_BASE,
          position: 'absolute',
          left: -11,
          top: 22,
          background: d.connected ? '#34d399' : 'transparent',
          borderColor: '#34d399',
        }}
      />
      <div className="flex items-center gap-1.5">
        <Icon size={12} className="text-emerald-400" />
        <span className="text-xs font-medium text-slate-100">App output</span>
      </div>
      <div className="mt-0.5 text-[9px] leading-tight text-slate-500">
        {d.connected
          ? `Saved as a ${d.outputKind} resource and returned to the tool or flow node.`
          : 'No result node picked — wire one in.'}
      </div>
    </div>
  );
});
