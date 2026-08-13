import { Link2Off, Pencil, Target } from 'lucide-react';
import { useState } from 'react';
import { Button, Checkbox, Field, Hint, Input, Select } from '../../components/ui';
import type { BindingMeta, WorkflowBinding, WorkflowNode, WorkflowNodeInput } from '../../lib/api';
import {
  bindingPortColor,
  CUSTOM_PREFIX,
  customName,
  inputValueLabel,
  isCustomKey,
  nodeRoleColor,
  specLabel,
} from './bindingPorts';

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
  onDeclareCustom,
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
  /** Declare (or re-declare) a parameter this workflow invents, pinned to one node input. */
  onDeclareCustom: (key: string, binding: WorkflowBinding) => void;
  onOutputNode: (nodeId: string) => void;
  onSelectNode: (id: string) => void;
}) {
  const [draft, setDraft] = useState<CustomDraft | null>(null);

  return (
    <aside className="glass flex w-72 shrink-0 flex-col overflow-auto border-l">
      {draft ? (
        <CustomParamForm
          draft={draft}
          taken={Object.keys(bindings)}
          onCancel={() => setDraft(null)}
          onSave={(key, binding) => {
            // Renaming a custom parameter is a delete + re-declare: the key is the identity, and a
            // stale one left behind would keep driving the graph.
            if (draft.originalKey && draft.originalKey !== key) onUnbind(draft.originalKey);
            onDeclareCustom(key, binding);
            setDraft(null);
          }}
        />
      ) : node ? (
        <NodeInspector
          node={node}
          catalog={catalog}
          bindings={bindings}
          isResult={node.id === outputNodeId}
          onBind={onBind}
          onUnbind={onUnbind}
          onNewCustom={(input) => setDraft(draftFor(node, input, bindings))}
          onEditCustom={(key) => setDraft(draftFrom(key, bindings[key]!))}
          onOutputNode={onOutputNode}
        />
      ) : (
        <MappingSummary
          catalog={catalog}
          bindings={bindings}
          nodes={nodes}
          onUnbind={onUnbind}
          onEditCustom={(key) => setDraft(draftFrom(key, bindings[key]!))}
          onSelectNode={onSelectNode}
        />
      )}
    </aside>
  );
}

/** Sentinel value in the bind dropdown: "this input drives something the catalog doesn't know yet". */
const NEW_CUSTOM = '__new_custom__';

/** The custom-parameter editor's working copy — strings throughout, parsed on save. */
interface CustomDraft {
  /** Set when editing an existing parameter, so a rename can clean up after itself. */
  originalKey: string | null;
  name: string;
  label: string;
  description: string;
  choices: string;
  value: string;
  agentEditable: boolean;
  node_id: string;
  input: string;
  spec?: WorkflowBinding['spec'];
}

/** A new parameter for the input the operator is looking at, seeded from what that input already holds. */
function draftFor(
  node: WorkflowNode,
  input: WorkflowNodeInput,
  bindings: Record<string, WorkflowBinding>,
): CustomDraft {
  const base = input.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'param';
  let name = base;
  for (let n = 2; bindings[`${CUSTOM_PREFIX}${name}`]; n += 1) name = `${base}_${n}`;
  return {
    originalKey: null,
    name,
    label: input.name,
    description: input.tooltip ?? '',
    // A dropdown whose options ComfyUI *does* publish needs no typing; one whose widget builds them
    // (`CustomCombo`) arrives empty, and that is exactly the case this editor exists for.
    choices: (input.options ?? []).join(', '),
    value: input.value === null || input.value === undefined ? '' : String(input.value),
    agentEditable: false,
    node_id: node.id,
    input: input.name,
    spec: input.type === 'LINK' ? undefined : { type: input.type },
  };
}

function draftFrom(key: string, binding: WorkflowBinding): CustomDraft {
  return {
    originalKey: key,
    name: customName(key),
    label: binding.label ?? '',
    description: binding.description ?? '',
    choices: (binding.choices ?? []).join(', '),
    value: binding.default === undefined ? '' : String(binding.default),
    agentEditable: binding.agent_editable === true,
    node_id: binding.node_id,
    input: binding.input,
    spec: binding.spec,
  };
}

/**
 * Declare a parameter that exists only on this graph.
 *
 * The built-in catalog covers what every workflow has; this covers what one workflow *invented* — a
 * category selector, a style preset, a LoRA strength. The choices field is the important one: a
 * ComfyUI node whose dropdown is built by its own widget publishes an empty option list, so the
 * allowed values genuinely cannot be discovered and have to be written down here.
 */
function CustomParamForm({
  draft,
  taken,
  onCancel,
  onSave,
}: {
  draft: CustomDraft;
  taken: string[];
  onCancel: () => void;
  onSave: (key: string, binding: WorkflowBinding) => void;
}) {
  const [form, setForm] = useState(draft);
  const set = <K extends keyof CustomDraft>(key: K, value: CustomDraft[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const name = form.name.trim().toLowerCase();
  const choices = form.choices.split(',').map((c) => c.trim()).filter(Boolean);
  const key = `${CUSTOM_PREFIX}${name}`;
  const clash = key !== form.originalKey && taken.includes(key);
  const error = !/^[a-z][a-z0-9_]{0,31}$/.test(name)
    ? 'Use a lower_snake_case name: letters, digits and underscores, starting with a letter.'
    : clash
      ? 'This workflow already has a parameter with that name.'
      : choices.length > 0 && form.value.trim() && !choices.includes(form.value.trim())
        ? 'The default must be one of the choices.'
        : null;

  return (
    <div className="animate-fade-up space-y-3 p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {form.originalKey ? 'Edit custom input' : 'New custom input'}
      </div>
      <div className="rounded-lg bg-black/25 p-2 font-mono text-[10px] text-slate-400 ring-1 ring-white/[0.06]">
        → #{form.node_id} · {form.input}
      </div>

      <Field label="Name" hint="How flows and agents address it.">
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="category" />
      </Field>
      <Field label="Label">
        <Input value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="Category" />
      </Field>
      <Field label="Description" hint="Shown in the inspector, and given to the agent as the argument's doc.">
        <Input
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="Which kind of audio the graph writes."
        />
      </Field>
      <Field label="Choices" hint="Comma-separated. Leave empty for a free value.">
        <Input
          value={form.choices}
          onChange={(e) => set('choices', e.target.value)}
          placeholder="Music, Instrument, SFX, One-shot"
        />
      </Field>
      <Field label="Default" hint="Used when nothing else supplies a value.">
        {choices.length > 0 ? (
          <Select value={form.value} onChange={(e) => set('value', e.target.value)}>
            <option value="">— leave the graph's own value —</option>
            {choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        ) : (
          <Input value={form.value} onChange={(e) => set('value', e.target.value)} />
        )}
      </Field>
      <Checkbox checked={form.agentEditable} onChange={(v) => set('agentEditable', v)}>
        An agent may set it on a tool call
      </Checkbox>

      {error && <div className="text-[10px] leading-tight text-red-400">{error}</div>}

      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={Boolean(error)}
          onClick={() =>
            onSave(key, {
              node_id: form.node_id,
              input: form.input,
              ...(form.spec ? { spec: form.spec } : {}),
              ...(form.label.trim() ? { label: form.label.trim() } : {}),
              ...(form.description.trim() ? { description: form.description.trim() } : {}),
              ...(choices.length ? { choices } : {}),
              ...(form.value.trim() ? { default: form.value.trim() } : {}),
              agent_editable: form.agentEditable,
            })
          }
        >
          {form.originalKey ? 'Update' : 'Create'}
        </Button>
        <Button onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  catalog,
  bindings,
  isResult,
  onBind,
  onUnbind,
  onNewCustom,
  onEditCustom,
  onOutputNode,
}: {
  node: WorkflowNode;
  catalog: BindingMeta[];
  bindings: Record<string, WorkflowBinding>;
  isResult: boolean;
  onBind: (key: string, nodeId: string, input: string) => void;
  onUnbind: (key: string) => void;
  onNewCustom: (input: WorkflowNodeInput) => void;
  onEditCustom: (key: string) => void;
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
                      // The catalog only holds parameters that exist; this one has to be described
                      // first, so it opens the editor instead of binding anything.
                      if (key === NEW_CUSTOM) {
                        onNewCustom(input);
                        return;
                      }
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
                    <option value={NEW_CUSTOM}>+ new custom input…</option>
                  </Select>
                  {bound && isCustomKey(bound) && (
                    <button
                      onClick={() => onEditCustom(bound)}
                      title={`Edit ${customName(bound)}`}
                      className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-accent"
                    >
                      <Pencil size={12} />
                    </button>
                  )}
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
  onEditCustom,
  onSelectNode,
}: {
  catalog: BindingMeta[];
  bindings: Record<string, WorkflowBinding>;
  nodes: WorkflowNode[];
  onUnbind: (key: string) => void;
  onEditCustom: (key: string) => void;
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
                {meta.custom && (
                  <button
                    onClick={() => onEditCustom(meta.key)}
                    title="Edit this custom input"
                    className="ml-auto shrink-0 text-slate-600 transition-colors hover:text-accent"
                  >
                    <Pencil size={11} />
                  </button>
                )}
                {binding ? (
                  <button
                    onClick={() => onUnbind(meta.key)}
                    title="Unbind"
                    className={`${meta.custom ? '' : 'ml-auto '}shrink-0 text-slate-600 transition-colors hover:text-red-400`}
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
        so binding one that another node currently feeds is allowed — the app's value simply wins. For a
        knob only this graph has, select the node, then pick <em>+ new custom input</em> on that input:
        it becomes a port here, a field on the flow node, and — if you allow it — a tool argument.
      </Hint>
    </div>
  );
}
