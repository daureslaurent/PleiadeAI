import { Link2Off, Target } from 'lucide-react';
import { Hint, Select } from '../../components/ui';
import type { BindingMeta, WorkflowBinding, WorkflowNode } from '../../lib/api';
import { bindingPortColor, inputValueLabel, nodeRoleColor, specLabel } from './bindingPorts';

/**
 * The rail beside the mapping canvas.
 *
 * With a node selected it is the precise view — every input, its constraints, its current literal, and
 * a dropdown to bind it. With nothing selected it is the summary: what the app will drive, and what it
 * won't. Both paths exist because wiring is fast but a dropdown is exact, and correcting one binding
 * shouldn't require aiming a mouse at a 9px handle.
 */
export function MappingInspector({
  node,
  nodes,
  catalog,
  bindings,
  outputNodeId,
  onBind,
  onUnbind,
  onOutputNode,
  onSelectNode,
}: {
  node: WorkflowNode | null;
  nodes: WorkflowNode[];
  catalog: BindingMeta[];
  bindings: Record<string, WorkflowBinding>;
  outputNodeId: string;
  onBind: (key: string, nodeId: string, input: string) => void;
  onUnbind: (key: string) => void;
  onOutputNode: (nodeId: string) => void;
  onSelectNode: (id: string) => void;
}) {
  return (
    <aside className="glass flex w-72 shrink-0 flex-col overflow-auto border-l">
      {node ? (
        <NodeInspector
          node={node}
          catalog={catalog}
          bindings={bindings}
          isResult={node.id === outputNodeId}
          onBind={onBind}
          onUnbind={onUnbind}
          onOutputNode={onOutputNode}
        />
      ) : (
        <MappingSummary
          catalog={catalog}
          bindings={bindings}
          nodes={nodes}
          onUnbind={onUnbind}
          onSelectNode={onSelectNode}
        />
      )}
    </aside>
  );
}

function NodeInspector({
  node,
  catalog,
  bindings,
  isResult,
  onBind,
  onUnbind,
  onOutputNode,
}: {
  node: WorkflowNode;
  catalog: BindingMeta[];
  bindings: Record<string, WorkflowBinding>;
  isResult: boolean;
  onBind: (key: string, nodeId: string, input: string) => void;
  onUnbind: (key: string) => void;
  onOutputNode: (nodeId: string) => void;
}) {
  const keyFor = (input: string): string =>
    Object.entries(bindings).find(([, b]) => b.node_id === node.id && b.input === input)?.[0] ?? '';

  return (
    <div className="animate-fade-up space-y-3 p-3">
      <div>
        <div className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: nodeRoleColor(node.class_type, isResult) }}
          />
          <span className="truncate text-sm text-slate-100">{node.title}</span>
          <span className="ml-auto shrink-0 rounded bg-white/[0.06] px-1 font-mono text-[10px] text-slate-500">
            #{node.id}
          </span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
          {node.class_type}
          {node.category && <span className="text-slate-600"> · {node.category}</span>}
        </div>
      </div>

      {node.is_output && (
        <button
          onClick={() => onOutputNode(node.id)}
          disabled={isResult}
          className={`flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] transition-colors ${
            isResult
              ? 'bg-emerald-500/10 text-emerald-400'
              : 'bg-white/[0.05] text-slate-300 hover:bg-white/[0.1] active:scale-95'
          }`}
        >
          <Target size={11} />
          {isResult ? 'This node is the result' : 'Use this node as the result'}
        </button>
      )}

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">Inputs</div>
        {node.inputs.map((input) => {
          const bound = keyFor(input.name);
          const meta = catalog.find((m) => m.key === bound);
          return (
            <div key={input.name} className="rounded-lg bg-black/25 p-2 ring-1 ring-white/[0.06]">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-mono text-[11px] text-slate-300">{input.name}</span>
                <span className="ml-auto shrink-0 text-[9px] text-slate-600">{specLabel(input)}</span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                {inputValueLabel(input)}
              </div>

              {input.bindable ? (
                <div className="mt-1.5 flex items-center gap-1">
                  <Select
                    value={bound}
                    onChange={(e) => {
                      const key = e.target.value;
                      if (bound && bound !== key) onUnbind(bound);
                      if (key) onBind(key, node.id, input.name);
                    }}
                    className="min-w-0 flex-1"
                  >
                    <option value="">— not driven by the app —</option>
                    {catalog.map((meta) => (
                      <option key={meta.key} value={meta.key}>
                        {meta.key}
                        {bindings[meta.key] && bindings[meta.key]!.input !== input.name ? ' (move here)' : ''}
                      </option>
                    ))}
                  </Select>
                  {bound && (
                    <button
                      onClick={() => onUnbind(bound)}
                      title={`Unbind ${bound}`}
                      className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Link2Off size={12} />
                    </button>
                  )}
                </div>
              ) : (
                <div className="mt-1 text-[9px] text-slate-600">
                  Wired from another node — no value can be written here.
                </div>
              )}

              {meta && (
                <div className="mt-1.5 border-t border-white/[0.06] pt-1.5 text-[9px] leading-tight text-slate-500">
                  <span style={{ color: bindingPortColor(meta.port) }}>{meta.label}</span> — {meta.source}
                  {input.is_link && (
                    <span className="text-amber-400">
                      {' '}
                      This input is currently fed by another node; the app's value overrides it.
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** No node selected: the whole mapping at a glance. */
function MappingSummary({
  catalog,
  bindings,
  nodes,
  onUnbind,
  onSelectNode,
}: {
  catalog: BindingMeta[];
  bindings: Record<string, WorkflowBinding>;
  nodes: WorkflowNode[];
  onUnbind: (key: string) => void;
  onSelectNode: (id: string) => void;
}) {
  const shown = catalog.filter((m) => m.expected || bindings[m.key]);

  return (
    <div className="animate-fade-up space-y-3 p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">Mapping</div>
      <div className="space-y-1.5">
        {shown.map((meta) => {
          const binding = bindings[meta.key];
          const node = binding ? nodes.find((n) => n.id === binding.node_id) : undefined;
          const color = bindingPortColor(meta.port);
          return (
            <div key={meta.key} className="rounded-lg bg-black/25 p-2 ring-1 ring-white/[0.06]">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                <span className="truncate text-[11px] text-slate-200">{meta.label}</span>
                {binding ? (
                  <button
                    onClick={() => onUnbind(meta.key)}
                    title="Unbind"
                    className="ml-auto shrink-0 text-slate-600 transition-colors hover:text-red-400"
                  >
                    <Link2Off size={11} />
                  </button>
                ) : (
                  <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wide text-amber-400">
                    unbound
                  </span>
                )}
              </div>
              {binding ? (
                <button
                  onClick={() => onSelectNode(binding.node_id)}
                  className="mt-0.5 block max-w-full truncate font-mono text-[10px] text-slate-400 transition-colors hover:text-accent"
                >
                  → #{binding.node_id} {node?.title ?? '(missing node)'} · {binding.input}
                </button>
              ) : (
                <div className="mt-0.5 text-[9px] leading-tight text-slate-500">{meta.description}</div>
              )}
            </div>
          );
        })}
      </div>
      <Hint>
        Drag a parameter's port onto a node input to bind it. A bound input is overwritten at run time,
        so binding one that another node currently feeds is allowed — the app's value simply wins.
      </Hint>
    </div>
  );
}
