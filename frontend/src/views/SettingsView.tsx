import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Brain,
  Check,
  DatabaseBackup,
  Download,
  Loader2,
  MonitorCog,
  Plus,
  RefreshCw,
  RefreshCcwDot,
  Server,
  SlidersHorizontal,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  agentsApi,
  endpointsApi,
  settingsApi,
  transferApi,
  type Agent,
  type Endpoint,
  type EndpointPatch,
  type ImportSummary,
  type InferenceSettings,
} from '../lib/api';
import { usePrefs } from '../store/prefs';
import { UpdatePanel } from '../components/UpdatePanel';

/** Settings page: tune llama.cpp connection + generation options at runtime (spec §1 dark UI). */
export function SettingsView() {
  const [form, setForm] = useState<InferenceSettings | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const showSubagentThinking = usePrefs((s) => s.showSubagentThinking);
  const setShowSubagentThinking = usePrefs((s) => s.setShowSubagentThinking);

  function loadEndpoints() {
    return endpointsApi.list().then(setEndpoints);
  }

  useEffect(() => {
    settingsApi.get().then(setForm);
    void loadEndpoints();
  }, []);

  function set<K extends keyof InferenceSettings>(key: K, value: InferenceSettings[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setStatus('idle');
  }

  async function save() {
    if (!form) return;
    setStatus('saving');
    const updated = await settingsApi.update(form);
    setForm(updated);
    setStatus('saved');
  }

  if (!form) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        {/* Endpoints — one or more OpenAI-compatible inference servers; models autodiscovered */}
        <Section
          icon={Server}
          title="Inference Endpoints"
          subtitle="OpenAI-compatible servers (llama.cpp, vLLM, Ollama…). Agents pick one, or use the default. Give one a fallback priority for automatic failover."
        >
          {/* Read-only summary of the fleet default (the ★ endpoint + its default model). Set it via
              the per-endpoint ★ 'Make default' and 'Default model' controls below. */}
          {(() => {
            const def = endpoints.find((e) => e.is_default);
            const model = def?.default_model || def?.models[0] || '—';
            return (
              <div className="rounded-md border border-border bg-panel px-3 py-2 text-xs text-slate-400">
                Fleet default:{' '}
                {def ? (
                  <>
                    <span className="text-slate-200">{def.name}</span> /{' '}
                    <span className="text-slate-200">{model}</span>
                  </>
                ) : (
                  <span className="text-slate-500">no default endpoint set</span>
                )}
              </div>
            );
          })()}
          <EndpointsManager endpoints={endpoints} reload={loadEndpoints} />
        </Section>

        {/* Embeddings — separate CPU llama.cpp server backing Qdrant vector memory */}
        <Section icon={Brain} title="Embeddings" subtitle="Vector memory (Qdrant) — separate embeddings server">
          <Field label="Embeddings URL" hint="OpenAI-compatible base of the --embedding llama.cpp server, e.g. http://embeddings:8080">
            <TextInput value={form.embedding_url} onChange={(v) => set('embedding_url', v)} />
          </Field>
          <Field label="Embedding model" hint="Model name the embeddings server reports">
            <TextInput value={form.embedding_model} onChange={(v) => set('embedding_model', v)} />
          </Field>
          <Field label="API Key" hint="Usually not required for local llama.cpp">
            <TextInput value={form.embedding_api_key} onChange={(v) => set('embedding_api_key', v)} password />
          </Field>
        </Section>

        {/* Generation */}
        <Section icon={SlidersHorizontal} title="Generation" subtitle="Sampling parameters">
          <Field label="Max tokens" hint="Upper bound on generated tokens per turn">
            <NumberInput value={form.max_tokens} min={1} step={1} onChange={(v) => set('max_tokens', v)} />
          </Field>
          <Field label="Context window" hint="Model n_ctx — used to show session context usage in chat">
            <NumberInput value={form.context_window} min={1} step={1} onChange={(v) => set('context_window', v)} />
          </Field>
          <Slider
            label="Temperature"
            value={form.temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => set('temperature', v)}
          />
          <Slider
            label="Top P"
            value={form.top_p}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set('top_p', v)}
          />
          <Field
            label="Title generation model"
            hint="Model that names new sessions. “Agent's own model” reuses whatever the responding agent used; or pick a specific (e.g. cheaper) endpoint. Failover applies either way."
          >
            <div className="flex gap-2">
              <select
                value={form.title_endpoint_id}
                onChange={(e) => {
                  set('title_endpoint_id', e.target.value);
                  set('title_model', '');
                }}
                className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
              >
                <option value="">Agent's own model</option>
                {endpoints.map((e) => (
                  <option key={e._id} value={e._id}>
                    {e.name}
                  </option>
                ))}
              </select>
              {form.title_endpoint_id && (
                <select
                  value={form.title_model}
                  onChange={(e) => set('title_model', e.target.value)}
                  className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
                >
                  <option value="">Endpoint default</option>
                  {(endpoints.find((e) => e._id === form.title_endpoint_id)?.models ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Field>
          <Field
            label="Title max tokens"
            hint="Token budget for the title call. Reasoning models spend tokens on a <think> block first, so keep this generous (≥256) — too low truncates mid-reasoning and produces no title."
          >
            <NumberInput
              value={form.title_max_tokens}
              min={32}
              step={1}
              onChange={(v) => set('title_max_tokens', v)}
            />
          </Field>
        </Section>

        {/* Interface — client-side display preferences (applied instantly, not part of Save) */}
        <Section icon={MonitorCog} title="Interface" subtitle="Display preferences (saved on this device)">
          <Toggle
            label="Show sub-agent thinking"
            hint="Render the collapsible reasoning block for delegated sub-agents. The top-level agent's thinking is always shown."
            checked={showSubagentThinking}
            onChange={setShowSubagentThinking}
          />
        </Section>

        {/* System & Updates — host self-update bridge (git pull + rebuild). Off by default. */}
        <Section
          icon={RefreshCcwDot}
          title="System & Updates"
          subtitle="Pull the latest master and rebuild the stack from here. Requires the host update watcher (tools/updater)."
        >
          <Toggle
            label="Enable app updates"
            hint="Master switch for the update check and the 'Update app' action. Off by default — the host watcher must also be installed."
            checked={form.update_enabled}
            onChange={(v) => set('update_enabled', v)}
          />
          <Field
            label="Check interval (hours)"
            hint="How often the backend runs a read-only update check (git fetch + compare). Minimum 1."
          >
            <NumberInput
              value={form.update_check_interval_hours}
              min={1}
              step={1}
              onChange={(v) => set('update_check_interval_hours', v)}
            />
          </Field>
          <div className="border-t border-border pt-4">
            <UpdatePanel enabled={form.update_enabled} />
          </div>
        </Section>

        {/* Backup & Transfer — export/import agents + isolations; export Qdrant memory (archival) */}
        <Section
          icon={DatabaseBackup}
          title="Backup & Transfer"
          subtitle="Export agents + isolations (and Qdrant memory) to a file, or import a config onto this instance."
        >
          <BackupTransfer />
        </Section>

        {/* Sticky save bar */}
        <div className="flex items-center justify-end gap-3">
          {status === 'saved' && (
            <span className="flex items-center gap-1 text-xs text-emerald-400">
              <Check size={14} /> Saved
            </span>
          )}
          <button
            onClick={save}
            disabled={status === 'saving'}
            className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {status === 'saving' && <Loader2 size={15} className="animate-spin" />}
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: typeof Server;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Icon size={16} className="text-accent" />
        <div>
          <div className="text-sm font-semibold text-slate-100">{title}</div>
          <div className="text-xs text-slate-500">{subtitle}</div>
        </div>
      </div>
      <div className="space-y-4 p-5">{children}</div>
    </section>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Export/import panel. Export operates on a selectable subset of agents (with a select-all);
 * the referenced isolations + Qdrant namespaces are pulled in automatically by the backend.
 * Import reads a previously exported *config* file (agents + isolations) — memory is not
 * re-imported — and overwrites any same-named agent/isolation.
 */
function BackupTransfer() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | 'config' | 'memory' | 'import'>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    agentsApi
      .list()
      .then((list) => {
        setAgents(list);
        setSelected(new Set(list.map((a) => a._id))); // default: all selected
      })
      .catch(() => setNote({ kind: 'err', text: 'Failed to load agents' }));
  }, []);

  const allSelected = agents.length > 0 && selected.size === agents.length;
  const ids = useMemo(() => [...selected], [selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(agents.map((a) => a._id)));
  }

  async function doExport(kind: 'config' | 'memory') {
    if (ids.length === 0) {
      setNote({ kind: 'err', text: 'Select at least one agent to export.' });
      return;
    }
    setBusy(kind);
    setNote(null);
    setSummary(null);
    try {
      const all = allSelected;
      const blob =
        kind === 'config'
          ? await transferApi.exportConfig(ids, all)
          : await transferApi.exportMemory(ids, all);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(blob, `pleiade-${kind}-${stamp}.json`);
      setNote({ kind: 'ok', text: `${kind === 'config' ? 'Config' : 'Memory'} exported (${ids.length} agent${ids.length === 1 ? '' : 's'}).` });
    } catch {
      setNote({ kind: 'err', text: 'Export failed.' });
    } finally {
      setBusy(null);
    }
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    setNote(null);
    setSummary(null);

    let bundle: unknown;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      setNote({ kind: 'err', text: 'That file is not valid JSON.' });
      return;
    }
    if ((bundle as { type?: string })?.type !== 'pleiade-config') {
      setNote({ kind: 'err', text: 'Not a Pleiade config file (expected a pleiade-config export).' });
      return;
    }
    const agentCount = (bundle as { agents?: unknown[] }).agents?.length ?? 0;
    if (!window.confirm(`Import ${agentCount} agent(s) and their isolations? Any with the same name will be OVERWRITTEN.`)) {
      return;
    }

    setBusy('import');
    try {
      const result = await transferApi.importConfig(bundle);
      setSummary(result);
      setNote({ kind: 'ok', text: 'Import complete.' });
      // Refresh the agent list so newly imported agents appear in the selector.
      agentsApi.list().then(setAgents).catch(() => undefined);
    } catch {
      setNote({ kind: 'err', text: 'Import failed.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Agent selector */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm text-slate-300">Agents to export</div>
          <button onClick={toggleAll} className="text-xs text-accent hover:underline">
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>
        <div className="max-h-44 overflow-auto rounded-md border border-border bg-panel p-1">
          {agents.length === 0 ? (
            <div className="px-2 py-3 text-xs text-slate-500">No agents.</div>
          ) : (
            agents.map((a) => (
              <label
                key={a._id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-300 hover:bg-surface"
              >
                <input
                  type="checkbox"
                  checked={selected.has(a._id)}
                  onChange={() => toggle(a._id)}
                  className="accent-accent"
                />
                <span className="truncate">{a.name}</span>
                {a.isolation_id && (
                  <span className="ml-auto shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-slate-500">
                    isolated
                  </span>
                )}
              </label>
            ))
          )}
        </div>
        <div className="mt-1 text-xs text-slate-500">
          Referenced isolations and Qdrant namespaces are included automatically. Secrets (SSH private
          keys, secret-looking parameter values) are stripped from exports.
        </div>
      </div>

      {/* Export actions */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => doExport('config')}
          disabled={busy !== null}
          className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-sm text-slate-200 hover:bg-surface disabled:opacity-50"
        >
          {busy === 'config' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          Export config
        </button>
        <button
          onClick={() => doExport('memory')}
          disabled={busy !== null}
          className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-sm text-slate-200 hover:bg-surface disabled:opacity-50"
        >
          {busy === 'memory' ? <Loader2 size={15} className="animate-spin" /> : <Brain size={15} />}
          Export memory
        </button>
      </div>

      <div className="border-t border-border pt-4">
        <div className="mb-2 text-sm text-slate-300">Import config</div>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={onImportFile} className="hidden" />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-sm text-slate-200 hover:bg-surface disabled:opacity-50"
        >
          {busy === 'import' ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          Choose config file…
        </button>
        <div className="mt-1 flex items-start gap-1.5 text-xs text-amber-400/80">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>Same-named agents and isolations are overwritten. Memory dumps cannot be imported.</span>
        </div>
      </div>

      {note && (
        <div className={`text-xs ${note.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>{note.text}</div>
      )}
      {summary && (
        <div className="rounded-md border border-border bg-panel p-3 text-xs text-slate-400">
          <div>
            Isolations: {summary.isolations.created} created, {summary.isolations.overwritten} overwritten
          </div>
          <div>
            Agents: {summary.agents.created} created, {summary.agents.overwritten} overwritten
          </div>
          {summary.warnings.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-amber-400/80">
              {summary.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm text-slate-300">{label}</div>
        {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={[
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors',
          checked ? 'bg-accent' : 'bg-panel ring-1 ring-border',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-0.5',
          ].join(' ')}
        />
      </button>
    </div>
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

function TextInput({
  value,
  onChange,
  password,
}: {
  value: string;
  onChange: (v: string) => void;
  password?: boolean;
}) {
  return (
    <input
      type={password ? 'password' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
    />
  );
}

function NumberInput({
  value,
  onChange,
  min,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-40 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
    />
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm text-slate-300">
        <span>{label}</span>
        <span className="font-mono text-xs text-slate-400">{value}</span>
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent"
      />
    </div>
  );
}

/**
 * Manage inference endpoints: add/edit URL+key, autodiscover the model list (`/v1/models`), pick
 * the fleet default, delete. Edits to an existing endpoint's fields save on blur; discovery and
 * default/delete apply immediately. `reload` re-pulls the list after every mutation.
 */
function EndpointsManager({ endpoints, reload }: { endpoints: Endpoint[]; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || !url.trim()) return;
    await endpointsApi.create({ name: name.trim(), base_url: url.trim(), api_key: apiKey, context_window: 0 });
    setName('');
    setUrl('');
    setApiKey('');
    setAdding(false);
    await reload();
  }

  async function discover(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await endpointsApi.discover(id);
      await reload();
    } catch {
      setError('Discovery failed — check the URL/key and that the server is reachable.');
    } finally {
      setBusyId(null);
    }
  }

  async function patch(id: string, p: EndpointPatch) {
    await endpointsApi.update(id, p);
    await reload();
  }

  return (
    <div className="space-y-3">
      {endpoints.map((e) => (
        <div key={e._id} className="space-y-2 rounded-md border border-border bg-panel p-3">
          <div className="flex items-center gap-2">
            <input
              defaultValue={e.name}
              readOnly={e.managed}
              onBlur={(ev) => !e.managed && ev.target.value !== e.name && void patch(e._id, { name: ev.target.value })}
              className={[
                'flex-1 rounded-md border border-border px-2 py-1.5 text-sm font-medium outline-none focus:border-accent',
                e.managed ? 'bg-panel text-slate-300' : 'bg-surface',
              ].join(' ')}
            />
            {e.managed && (
              <span
                className="flex items-center gap-1 rounded border border-emerald-900 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400"
                title="Built-in local llama.cpp fallback (docker). URL is fixed; model is auto-discovered."
              >
                <Server size={11} /> local
              </span>
            )}
            {e.is_default ? (
              <span className="flex items-center gap-1 rounded border border-amber-900 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
                <Star size={11} /> default
              </span>
            ) : (
              <button
                onClick={() => endpointsApi.setDefault(e._id).then(reload)}
                className="rounded border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-200"
              >
                Make default
              </button>
            )}
            {!e.managed && (
              <button
                onClick={async () => {
                  if (!confirm(`Delete endpoint “${e.name}”? Agents using it fall back to the default.`)) return;
                  await endpointsApi.remove(e._id);
                  await reload();
                }}
                className="rounded border border-red-900 p-1 text-red-400 hover:bg-red-950"
                title="Delete endpoint"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>

          <input
            defaultValue={e.base_url}
            placeholder="http://192.168.1.20:8080"
            readOnly={e.managed}
            title={e.managed ? 'Fixed URL of the built-in docker fallback (set via LLAMA_FALLBACK_URL)' : undefined}
            onBlur={(ev) => !e.managed && ev.target.value !== e.base_url && void patch(e._id, { base_url: ev.target.value })}
            className={[
              'w-full rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-accent',
              e.managed ? 'bg-panel text-slate-400' : 'bg-surface',
            ].join(' ')}
          />
          <div className="flex gap-2">
            <input
              type="password"
              defaultValue={e.api_key}
              placeholder="API key (optional)"
              onBlur={(ev) => ev.target.value !== e.api_key && void patch(e._id, { api_key: ev.target.value })}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <input
              type="number"
              defaultValue={e.context_window}
              min={0}
              title="Context window (0 = use global)"
              onBlur={(ev) =>
                Number(ev.target.value) !== e.context_window &&
                void patch(e._id, { context_window: Number(ev.target.value) })
              }
              className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-xs text-slate-500">
              {e.models.length ? (
                <span>
                  {e.models.length} model{e.models.length === 1 ? '' : 's'}:{' '}
                  <span className="text-slate-400">{e.models.slice(0, 4).join(', ')}</span>
                  {e.models.length > 4 ? '…' : ''}
                </span>
              ) : (
                <span className="text-slate-600">No models discovered yet.</span>
              )}
            </div>
            <button
              onClick={() => discover(e._id)}
              disabled={busyId === e._id}
              className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-xs text-slate-300 hover:text-white disabled:opacity-50"
            >
              <RefreshCw size={12} className={busyId === e._id ? 'animate-spin' : ''} /> Refresh models
            </button>
          </div>

          {/* Default model: what agents on this endpoint use when they don't pick one. The
              default endpoint's default model is the fleet-wide default. */}
          <label className="flex items-center gap-2">
            <span className="shrink-0 text-xs text-slate-400">Default model</span>
            <select
              value={e.default_model}
              onChange={(ev) => void patch(e._id, { default_model: ev.target.value })}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
            >
              <option value="">
                {e.models.length ? 'First available' : 'Refresh models to choose'}
              </option>
              {e.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {e.default_model && !e.models.includes(e.default_model) && (
                <option value={e.default_model}>{e.default_model} (custom)</option>
              )}
            </select>
          </label>

          {/* Failover position: 0 = off; 1, 2, 3… = order this endpoint is tried when the primary
              endpoint is unreachable (a local CPU llama.cpp container makes a good last resort). */}
          <label className="flex items-center gap-2">
            <span className="shrink-0 text-xs text-slate-400">Fallback priority</span>
            <input
              type="number"
              min={0}
              defaultValue={e.fallback_order}
              title="0 = not a fallback. 1, 2, 3… = order this endpoint is tried when the primary is unreachable."
              onBlur={(ev) =>
                Number(ev.target.value) !== e.fallback_order &&
                void patch(e._id, { fallback_order: Number(ev.target.value) })
              }
              className="w-20 rounded-md border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <span className="text-xs text-slate-500">0 = off</span>
          </label>
        </div>
      ))}

      {error && <p className="text-xs text-red-400">{error}</p>}

      {adding ? (
        <div className="space-y-2 rounded-md border border-dashed border-border bg-panel p-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. workstation)"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://192.168.1.20:8080"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API key (optional)"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="rounded px-3 py-1.5 text-xs text-slate-400">
              Cancel
            </button>
            <button
              onClick={create}
              disabled={!name.trim() || !url.trim()}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              Add endpoint
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-sm text-slate-400 hover:text-slate-200"
        >
          <Plus size={14} /> Add endpoint
        </button>
      )}
    </div>
  );
}
