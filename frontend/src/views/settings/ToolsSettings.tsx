import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Blocks,
  Check,
  Lock,
  Search,
  Unlock,
  Wrench,
} from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toolsApi, type ToolCategory, type ToolConfigField, type ToolInfo } from '../../lib/api';
import {
  Button,
  Callout,
  Field,
  GlassCard,
  Input,
  Select,
  Spinner,
  Toggle,
} from '../../components/ui';

type Values = Record<string, string | number | boolean>;

/**
 * The rail's section order and headings. Ordered by how often an operator comes here — the tools
 * with real options (web, files, shell, media) first, the auto-granted session plumbing last.
 */
const CATEGORY_LABELS: Record<ToolCategory, string> = {
  web: 'Web',
  files: 'Files',
  shell: 'Shell',
  media: 'Media',
  agents: 'Agents',
  memory: 'Memory',
  forum: 'Forum',
  mail: 'Mail',
  desktop: 'Desktop',
  android: 'Android',
  automation: 'Automation',
  session: 'Session',
  other: 'Other',
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as ToolCategory[];

/**
 * `/settings/tools[/:tool]` — the core-tool config surface, moved out of the sidebar and into
 * Settings (it is configuration, not a workspace).
 *
 * Unlike the other category pages this one is a rail + detail rather than a single column: there are
 * forty-odd tools, and a scrolling stack of forty cards is a page you can only read, not use. The
 * rail is the finder — type to filter across names *and* descriptions, ↑/↓ to walk the matches,
 * Enter to open the top one — and the selected tool is the whole right pane. The selection lives in
 * the URL, so a tool is linkable.
 */
export function ToolsSettings() {
  const { tool: selectedName } = useParams();
  const navigate = useNavigate();
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');

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

  // Matches on name *and* description, so "search the web" finds `web_search` even when the operator
  // doesn't remember what the tool is called.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!tools) return [];
    if (!q) return tools;
    return tools.filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }, [tools, query]);

  const groups = useMemo(() => {
    const byCategory = new Map<ToolCategory, ToolInfo[]>();
    for (const tool of matches) {
      const list = byCategory.get(tool.category) ?? [];
      list.push(tool);
      byCategory.set(tool.category, list);
    }
    return CATEGORY_ORDER.flatMap((category) => {
      const items = byCategory.get(category);
      return items ? [{ category, items }] : [];
    });
  }, [matches]);

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

  const selected = tools.find((t) => t.name === selectedName) ?? null;
  const open = (name: string) => navigate(`/settings/tools/${encodeURIComponent(name)}`);

  /** ↑/↓ walk the filtered list from wherever the selection is; Enter opens the top match. */
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
    const flat = groups.flatMap((g) => g.items);
    const first = flat[0];
    if (!first) return;
    event.preventDefault();
    if (event.key === 'Enter') {
      open((flat.find((t) => t.name === selectedName) ?? first).name);
      return;
    }
    const at = flat.findIndex((t) => t.name === selectedName);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = at === -1 ? (step === 1 ? 0 : flat.length - 1) : (at + step + flat.length) % flat.length;
    open(flat[next]!.name);
  }

  return (
    <div className="flex h-full">
      <aside className="glass flex w-64 shrink-0 flex-col border-r">
        <div className="space-y-2 p-2">
          <Link
            to="/settings"
            className="inline-flex items-center gap-1.5 px-1 text-xs text-slate-500 transition-colors hover:text-slate-300"
          >
            <ArrowLeft size={13} /> Settings
          </Link>
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-600" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search tools"
              className="pl-7 text-xs"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          {groups.length === 0 && (
            <div className="px-2 py-6 text-center text-[11px] text-slate-600">No tool matches.</div>
          )}
          {groups.map(({ category, items }) => (
            <div key={category} className="mb-2">
              <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                {CATEGORY_LABELS[category]}
              </div>
              {items.map((tool) => (
                <ToolRow
                  key={tool.name}
                  tool={tool}
                  active={tool.name === selectedName}
                  onSelect={() => open(tool.name)}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="border-t border-white/[0.06] px-3 py-2 font-mono text-[10px] text-slate-500">
          {toolSummary(tools)}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-auto">
        {selected ? (
          <div className="mx-auto max-w-2xl space-y-5 p-6">
            <ToolCard key={selected.name} tool={selected} onSaved={replace} />
          </div>
        ) : (
          <Overview tools={tools} onOpen={open} />
        )}
      </section>
    </div>
  );
}

const toolSummary = (tools: ToolInfo[]) => {
  const off = tools.filter((t) => !t.enabled).length;
  return `${tools.length} tools · ${off ? `${off} disabled` : 'all enabled'}`;
};

/** One rail row: an enabled dot, the tool's name, and (search's payoff) what it does. */
function ToolRow({
  tool,
  active,
  onSelect,
}: {
  tool: ToolInfo;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
        active
          ? 'bg-accent/15 text-accent shadow-[inset_2px_0_0_0_rgba(59,130,246,0.7)]'
          : 'text-slate-300 hover:bg-white/[0.05]'
      }`}
    >
      <span
        title={tool.enabled ? 'Enabled' : 'Disabled — no agent can call it'}
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          tool.enabled ? 'bg-emerald-400' : 'bg-slate-600'
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs">{tool.name}</span>
        {!active && (
          <span className="block truncate text-[10px] text-slate-600">{tool.description}</span>
        )}
      </span>
      {tool.configSchema.length > 0 && (
        <span
          title={`${tool.configSchema.length} option${tool.configSchema.length === 1 ? '' : 's'}`}
          className="shrink-0 rounded bg-white/[0.05] px-1 text-[9px] text-slate-500"
        >
          {tool.configSchema.length}
        </span>
      )}
    </button>
  );
}

/** Landing state: the two things worth knowing before you pick a tool. */
function Overview({ tools, onOpen }: { tools: ToolInfo[]; onOpen: (name: string) => void }) {
  const disabled = tools.filter((t) => !t.enabled);
  const configurable = tools.filter((t) => t.configSchema.length > 0);

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div className="animate-fade-up flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/20">
          <Blocks size={17} />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-100">Tools</h2>
          <p className="text-[11px] text-slate-500">
            Every core tool, with a master switch and its operator-tunable options. Disabling one
            drops it from every agent&apos;s toolset on the next turn.
          </p>
        </div>
      </div>

      <GlassCard className="p-5">
        <div className="text-xs font-medium text-slate-300">Disabled</div>
        {disabled.length === 0 ? (
          <p className="mt-1 text-[11px] text-slate-500">
            Nothing is switched off — every core tool is callable by an agent that lists it.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {disabled.map((t) => (
              <Chip key={t.name} label={t.name} onClick={() => onOpen(t.name)} />
            ))}
          </div>
        )}
      </GlassCard>

      <GlassCard className="p-5">
        <div className="text-xs font-medium text-slate-300">Has options</div>
        <p className="mt-1 text-[11px] text-slate-500">
          The rest are on/off only — everything they need comes from the agent&apos;s call.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {configurable.map((t) => (
            <Chip key={t.name} label={t.name} onClick={() => onOpen(t.name)} />
          ))}
        </div>
      </GlassCard>
    </div>
  );
}

function Chip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-slate-400 transition-colors hover:bg-accent/15 hover:text-accent"
    >
      {label}
    </button>
  );
}

function ToolCard({ tool, onSaved }: { tool: ToolInfo; onSaved: (t: ToolInfo) => void }) {
  const [enabled, setEnabled] = useState(tool.enabled);
  const [values, setValues] = useState<Values>(tool.config);
  const [locked, setLocked] = useState<Set<string>>(new Set(tool.locked));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  function set(key: string, value: string | number | boolean) {
    setValues((v) => ({ ...v, [key]: value }));
    setStatus('idle');
  }

  function toggleLock(key: string) {
    setLocked((l) => {
      const next = new Set(l);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setStatus('idle');
  }

  async function save() {
    setStatus('saving');
    try {
      const updated = await toolsApi.update(tool.name, { enabled, config: values, locked: [...locked] });
      setValues(updated.config);
      setEnabled(updated.enabled);
      setLocked(new Set(updated.locked));
      onSaved(updated);
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  const hasOptions = tool.configSchema.length > 0;

  return (
    <GlassCard className={`animate-fade-up transition-opacity ${enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3.5">
        <Wrench size={16} className={enabled ? 'text-accent' : 'text-slate-600'} />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-semibold text-slate-100">{tool.name}</div>
          <div className="text-xs text-slate-500">{tool.description}</div>
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
          {tool.configSchema.map((field) => {
            const isLocked = locked.has(field.key);
            return (
              <Field
                key={field.key}
                label={
                  field.lockable ? (
                    <span className="flex items-center gap-1.5">
                      {field.label}
                      <button
                        type="button"
                        onClick={() => toggleLock(field.key)}
                        title={isLocked ? 'Locked — agents cannot override this' : 'Unlocked — agents may override this'}
                        className={`rounded p-0.5 transition-colors ${isLocked ? 'text-amber-400 hover:text-amber-300' : 'text-slate-600 hover:text-slate-400'}`}
                      >
                        {isLocked ? <Lock size={11} /> : <Unlock size={11} />}
                      </button>
                    </span>
                  ) : (
                    field.label
                  )
                }
                hint={
                  field.lockable
                    ? `${field.hint ?? ''}${isLocked ? ' Locked: agent-supplied values are ignored.' : ''}`
                    : field.hint
                }
              >
                <ConfigInput
                  field={field}
                  value={values[field.key]}
                  onChange={(v) => set(field.key, v)}
                />
              </Field>
            );
          })}
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
            {/* Server-resolved options store an id and display a name (e.g. a ComfyUI workflow). */}
            {field.optionLabels?.[opt] ?? opt}
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
