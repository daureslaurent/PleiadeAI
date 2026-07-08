import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Wrench } from 'lucide-react';
import { toolsApi, type ToolConfigField, type ToolInfo } from '../lib/api';
import {
  Button,
  Callout,
  Field,
  GlassCard,
  Input,
  Select,
  Spinner,
  Toggle,
} from '../components/ui';

type Values = Record<string, string | number | boolean>;

/**
 * Tools page: every core tool with a master on/off switch and its operator-tunable options
 * (e.g. web_search's provider, endpoint, and API key). Each card saves independently.
 */
export function ToolsView() {
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    toolsApi
      .list()
      .then((t) => alive && setTools(t))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  function replace(updated: ToolInfo) {
    setTools((ts) => (ts ? ts.map((t) => (t.name === updated.name ? updated : t)) : ts));
  }

  if (error) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Callout tone="error" icon={<AlertTriangle size={14} />}>
          Failed to load tools. The backend may be down — reload once it&apos;s back.
        </Callout>
      </div>
    );
  }

  if (!tools) return <Spinner />;

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
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  function set(key: string, value: string | number | boolean) {
    setValues((v) => ({ ...v, [key]: value }));
    setStatus('idle');
  }

  async function save() {
    setStatus('saving');
    try {
      const updated = await toolsApi.update(tool.name, { enabled, config: values });
      setValues(updated.config);
      setEnabled(updated.enabled);
      onSaved(updated);
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  const hasOptions = tool.configSchema.length > 0;

  return (
    <GlassCard className={`transition-opacity ${enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3.5">
        <Wrench size={16} className={enabled ? 'text-accent' : 'text-slate-600'} />
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
              <ConfigInput
                field={field}
                value={values[field.key]}
                onChange={(v) => set(field.key, v)}
              />
            </Field>
          ))}
          <SaveBar status={status} onSave={save} />
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 px-5 py-3.5">
          <span className="text-xs text-slate-500">No options — enable/disable only.</span>
          <SaveBar status={status} onSave={save} />
        </div>
      )}
    </GlassCard>
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
  if (field.type === 'boolean') {
    return <Toggle checked={Boolean(value)} onChange={onChange} />;
  }
  if (field.type === 'select') {
    return (
      <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </Select>
    );
  }
  if (field.type === 'number') {
    return (
      <Input type="number" value={Number(value ?? 0)} onChange={(e) => onChange(Number(e.target.value))} />
    );
  }
  return (
    <Input
      type={field.type === 'password' ? 'password' : 'text'}
      autoComplete={field.type === 'password' ? 'new-password' : undefined}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function SaveBar({
  status,
  onSave,
}: {
  status: 'idle' | 'saving' | 'saved' | 'error';
  onSave: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-3">
      {status === 'saved' && (
        <span className="flex items-center gap-1 text-xs text-emerald-400">
          <Check size={14} /> Saved
        </span>
      )}
      {status === 'error' && (
        <span className="flex items-center gap-1 text-xs text-red-400">
          <AlertTriangle size={14} /> Save failed
        </span>
      )}
      <Button variant="primary" onClick={onSave} loading={status === 'saving'}>
        Save
      </Button>
    </div>
  );
}
