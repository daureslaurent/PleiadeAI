import { Trash2, X } from 'lucide-react';
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
  onChange,
  onDelete,
  onClose,
}: {
  node: FlowNode;
  nodeType: FlowNodeType | undefined;
  flowId: string;
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

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
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
            <Field key={field.key} label={field.label} hint={field.hint}>
              <ConfigInput
                field={field}
                value={node.config[field.key]}
                onChange={(v) => setConfig(field.key, v)}
              />
            </Field>
          ),
        )}

        {nodeType && nodeType.config.length === 0 && (
          <p className="text-xs text-slate-600">This node has no settings.</p>
        )}
      </div>

      <div className="border-t border-white/[0.06] p-3">
        <Button variant="danger" icon={<Trash2 size={13} />} onClick={onDelete} className="w-full">
          Delete node
        </Button>
      </div>
    </aside>
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
