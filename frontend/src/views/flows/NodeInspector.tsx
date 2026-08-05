import { Link2, Trash2, X } from 'lucide-react';
import { Button, Field, Input, Select, Textarea, Toggle } from '../../components/ui';
import type { FlowNode, FlowNodeType, PortType, ToolConfigField } from '../../lib/api';
import { GROUP_COLORS } from './portStyle';
import { ResourceInput } from './ResourceInput';

/** Fields rendered as a multi-line box — prompts and JSON argument sets need the room. */
const MULTILINE_KEYS = new Set(['prompt', 'question', 'args', 'text', 'default', 'expression']);

/**
 * The selected node's settings rail.
 *
 * The form is generated entirely from the backend's declared `config: ToolConfigField[]` — the same
 * field type the Tools page renders — so a new node type on the server shows up here complete, with
 * its selects already filled from the database (agents, ComfyUI workflows, tools).
 */
/** True for the `default` field of an `input` node whose port type carries bytes. */
function isBinaryDefault(node: FlowNode, key: string): boolean {
  if (node.type !== 'input' || key !== 'default') return false;
  return ['image', 'video', 'audio', 'file'].includes(String(node.config.port_type ?? 'text'));
}

export function NodeInspector({
  node,
  nodeType,
  flowId,
  nodes,
  readOnly = false,
  onChange,
  onDelete,
  onClose,
}: {
  node: FlowNode;
  nodeType: FlowNodeType | undefined;
  flowId: string;
  /** Every node in the flow, so a field can offer the references it could be driven by. */
  nodes: FlowNode[];
  /** True while reviewing a past run — settings are readable, but editing one would be a lie. */
  readOnly?: boolean;
  onChange: (patch: Partial<FlowNode>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const accent = GROUP_COLORS[nodeType?.group ?? 'io'] ?? GROUP_COLORS.io;

  const setConfig = (key: string, value: unknown) =>
    onChange({ config: { ...node.config, [key]: value } });

  return (
    <aside className="glass flex w-80 shrink-0 flex-col border-l">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-100">{nodeType?.label ?? node.type}</div>
          <div className="font-mono text-[10px] text-slate-600">{node.id}</div>
        </div>
        <button onClick={onClose} className="text-slate-500 transition-colors hover:text-slate-200">
          <X size={15} />
        </button>
      </div>

      <div
        className={`min-h-0 flex-1 space-y-4 overflow-auto p-4 ${
          readOnly ? 'pointer-events-none opacity-60' : ''
        }`}
      >
        {nodeType?.description && (
          <p className="text-[11px] leading-relaxed text-slate-500">{nodeType.description}</p>
        )}

        <Field label="Label" hint="Also usable in templates as {{label_slug}}.">
          <Input value={node.label} onChange={(e) => onChange({ label: e.target.value })} />
        </Field>

        {(nodeType?.config ?? []).map((field) =>
          // An `input` node of a binary type gets the uploader for its default, so a flow can ship
          // with a file already attached instead of an operator pasting a handle they can't know.
          isBinaryDefault(node, field.key) ? (
            <Field key={field.key} label="Default file" hint="Used when a run supplies nothing.">
              <ResourceInput
                flowId={flowId}
                type={String(node.config.port_type ?? 'file') as PortType}
                value={String(node.config[field.key] ?? '')}
                onChange={(v) => setConfig(field.key, v)}
              />
            </Field>
          ) : (
            <ConfigField
              key={field.key}
              field={field}
              value={node.config[field.key]}
              nodes={nodes}
              selfId={node.id}
              onChange={(v) => setConfig(field.key, v)}
            />
          ),
        )}

        {nodeType && nodeType.config.length === 0 && (
          <p className="text-xs text-slate-600">This node has no settings.</p>
        )}
      </div>

      {!readOnly && (
        <div className="border-t border-white/[0.06] p-3">
          <Button variant="danger" icon={<Trash2 size={13} />} onClick={onDelete} className="w-full">
            Delete node
          </Button>
        </div>
      )}
    </aside>
  );
}

/** True when a stored value is a template rather than a literal. */
function isReference(value: unknown): boolean {
  return typeof value === 'string' && value.includes('{{');
}

/**
 * One setting, with the option to drive it from another node instead of typing a literal.
 *
 * A number field is the case that forces this: a clip's duration is a `<input type="number">`, so
 * without a way to enter `{{duration}}` the value can only ever be a constant typed into that one
 * node. The link button swaps the control for a reference picker, which is what makes a `data` node
 * able to feed a setting that has no port — and the runner already interpolates every config field,
 * so nothing behind this needed to change.
 */
function ConfigField({
  field,
  value,
  nodes,
  selfId,
  onChange,
}: {
  field: ToolConfigField;
  value: unknown;
  nodes: FlowNode[];
  selfId: string;
  onChange: (v: unknown) => void;
}) {
  const linked = isReference(value);
  const others = nodes.filter((n) => n.id !== selfId && n.type !== 'note');

  return (
    <Field
      label={field.label}
      hint={linked ? 'Driven by another node. Its value is substituted before the node runs.' : field.hint}
    >
      <div className="space-y-1">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            {linked ? (
              <Input
                value={String(value ?? '')}
                onChange={(e) => onChange(e.target.value)}
                className="font-mono text-[11px]"
                placeholder="{{node_id}}"
              />
            ) : (
              <ConfigInput field={field} value={value} onChange={onChange} />
            )}
          </div>
          <button
            onClick={() => onChange(linked ? (field.default ?? '') : '{{}}')}
            title={linked ? 'Use a fixed value' : 'Drive this from another node'}
            className={`mt-1 shrink-0 rounded p-1 transition-colors ${
              linked ? 'text-accent' : 'text-slate-600 hover:text-slate-300'
            }`}
          >
            <Link2 size={12} />
          </button>
        </div>

        {linked && others.length > 0 && (
          <select
            value=""
            onChange={(e) => e.target.value && onChange(`{{${e.target.value}}}`)}
            className="w-full rounded border border-white/[0.1] bg-black/30 px-1.5 py-1 text-[10px] text-slate-400 outline-none focus:border-accent/50"
          >
            <option value="">Insert a reference…</option>
            {others.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label || n.type} ({n.id})
              </option>
            ))}
          </select>
        )}
      </div>
    </Field>
  );
}

function ConfigInput({
  field,
  value,
  onChange,
}: {
  field: ToolConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (field.type === 'boolean') {
    return <Toggle checked={Boolean(value)} onChange={onChange} />;
  }
  if (field.type === 'select') {
    return (
      <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {field.optionLabels?.[opt] ?? opt}
          </option>
        ))}
      </Select>
    );
  }
  if (field.type === 'number') {
    return (
      <Input
        type="number"
        value={Number(value ?? field.default ?? 0)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    );
  }
  if (MULTILINE_KEYS.has(field.key)) {
    return (
      <Textarea
        rows={4}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-[11px]"
      />
    );
  }
  return (
    <Input
      type={field.type === 'password' ? 'password' : 'text'}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
