import { useEffect, useState, type ReactNode } from 'react';
import { Check, Loader2, Wrench } from 'lucide-react';
import { toolsApi, type ToolConfigField, type ToolInfo } from '../lib/api';

type Values = Record<string, string | number | boolean>;

/**
 * Tools page: every core tool with a master on/off switch and its operator-tunable options
 * (e.g. web_search's provider, endpoint, and API key). Each card saves independently.
 */
export function ToolsView() {
  const [tools, setTools] = useState<ToolInfo[] | null>(null);

  useEffect(() => {
    toolsApi.list().then(setTools);
  }, []);

  function replace(updated: ToolInfo) {
    setTools((ts) => (ts ? ts.map((t) => (t.name === updated.name ? updated : t)) : ts));
  }

  if (!tools) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        {tools.map((tool) => (
          <ToolCard key={tool.name} tool={tool} onSaved={replace} />
        ))}
      </div>
    </div>
  );
}

function ToolCard({ tool, onSaved }: { tool: ToolInfo; onSaved: (t: ToolInfo) => void }) {
  const [enabled, setEnabled] = useState(tool.enabled);
  const [values, setValues] = useState<Values>(tool.config);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  function set(key: string, value: string | number | boolean) {
    setValues((v) => ({ ...v, [key]: value }));
    setStatus('idle');
  }

  async function save() {
    setStatus('saving');
    const updated = await toolsApi.update(tool.name, { enabled, config: values });
    setValues(updated.config);
    setEnabled(updated.enabled);
    onSaved(updated);
    setStatus('saved');
  }

  const hasOptions = tool.configSchema.length > 0;

  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Wrench size={16} className="text-accent" />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-semibold text-slate-100">{tool.name}</div>
          <div className="truncate text-xs text-slate-500">{tool.description}</div>
        </div>
        <Toggle
          checked={enabled}
          onChange={(v) => {
            setEnabled(v);
            setStatus('idle');
          }}
        />
      </div>

      {hasOptions ? (
        <div className="space-y-4 p-5">
          {tool.configSchema.map((field) => (
            <Field key={field.key} label={field.label} hint={field.hint}>
              <ConfigInput field={field} value={values[field.key]} onChange={(v) => set(field.key, v)} />
            </Field>
          ))}
          <SaveBar status={status} onSave={save} />
        </div>
      ) : (
        <div className="flex items-center justify-between px-5 py-3">
          <span className="text-xs text-slate-500">No options — enable/disable only.</span>
          <SaveBar status={status} onSave={save} />
        </div>
      )}
    </section>
  );
}

function ConfigInput({
  field,
  value,
  onChange,
}: {
  field: ToolConfigField;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
}) {
  const base =
    'w-full rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent';

  if (field.type === 'boolean') {
    return <Toggle checked={Boolean(value)} onChange={onChange} />;
  }
  if (field.type === 'select') {
    return (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={base}>
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'number') {
    return (
      <input
        type="number"
        value={Number(value ?? 0)}
        onChange={(e) => onChange(Number(e.target.value))}
        className={base}
      />
    );
  }
  return (
    <input
      type={field.type === 'password' ? 'password' : 'text'}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      className={base}
    />
  );
}

function SaveBar({ status, onSave }: { status: 'idle' | 'saving' | 'saved'; onSave: () => void }) {
  return (
    <div className="flex items-center justify-end gap-3">
      {status === 'saved' && (
        <span className="flex items-center gap-1 text-xs text-emerald-400">
          <Check size={14} /> Saved
        </span>
      )}
      <button
        onClick={onSave}
        disabled={status === 'saving'}
        className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {status === 'saving' && <Loader2 size={15} className="animate-spin" />}
        Save
      </button>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-panel border border-border'
      }`}
      aria-pressed={checked}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-sm text-slate-300">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </label>
  );
}
