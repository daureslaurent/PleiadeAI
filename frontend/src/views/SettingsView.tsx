import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Ban,
  Brain,
  Check,
  Copy,
  DatabaseBackup,
  Download,
  Eraser,
  FileLock2,
  KeyRound,
  Loader2,
  Gauge,
  MonitorCog,
  Plus,
  RefreshCw,
  RefreshCcwDot,
  Server,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  agentsApi,
  apiKeysApi,
  endpointsApi,
  finetuneServersApi,
  maintenanceApi,
  settingsApi,
  transferApi,
  type Agent,
  type ApiKey,
  type ClearSummary,
  type DataCounts,
  type Endpoint,
  type EndpointPatch,
  type FinetuneServer,
  type FinetuneServerPatch,
  type ImportSummary,
  type InferenceSettings,
  type ResetCategory,
} from '../lib/api';
import { usePrefs } from '../store/prefs';
import { UpdatePanel } from '../components/UpdatePanel';

/** Settings page: tune llama.cpp connection + generation options at runtime (spec §1 dark UI). */
export function SettingsView() {
  const [form, setForm] = useState<InferenceSettings | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [finetuneServers, setFinetuneServers] = useState<FinetuneServer[]>([]);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const showSubagentThinking = usePrefs((s) => s.showSubagentThinking);
  const setShowSubagentThinking = usePrefs((s) => s.setShowSubagentThinking);

  function loadEndpoints() {
    return endpointsApi.list().then(setEndpoints);
  }

  function loadFinetuneServers() {
    return finetuneServersApi.list().then(setFinetuneServers);
  }

  useEffect(() => {
    settingsApi.get().then(setForm);
    void loadEndpoints();
    void loadFinetuneServers();
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
          <EndpointsManager endpoints={endpoints} reload={loadEndpoints} globalAuto={form.context_window_auto} />
        </Section>

        {/* Fine-tune servers — remote GPU boxes running the headless training service */}
        <Section
          icon={Sparkles}
          title="Fine-tune Servers"
          subtitle="Remote GPU training servers driven from the Fine-Tuning page"
        >
          <FinetuneServersManager servers={finetuneServers} reload={loadFinetuneServers} />
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
          <Field
            label="Max tool steps per turn"
            hint="Fleet default for how many tool round-trips an agent may take before a turn is cut off. Each agent can override this on its own page."
          >
            <NumberInput value={form.max_tool_iterations} min={1} step={1} onChange={(v) => set('max_tool_iterations', v)} />
          </Field>
          <Toggle
            label="Auto-detect context window"
            hint="Read each server's real n_ctx (probed at model discovery) for the chat context meter. Endpoints can override this. When off, the number below is used for every endpoint that inherits."
            checked={form.context_window_auto}
            onChange={(v) => set('context_window_auto', v)}
          />
          <Field
            label="Context window"
            hint={
              form.context_window_auto
                ? 'Fallback n_ctx — used only when a server doesn’t report its context size.'
                : 'Model n_ctx — used to show session context usage in chat'
            }
          >
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
          <Field
            label="Vision endpoint (for visual agents)"
            hint="Screenshots from visual_screenshot are analysed here and returned to the agent as text + coordinates. Pick an endpoint whose model supports vision (llama.cpp with --mmproj)."
          >
            <div className="flex gap-2">
              <select
                value={form.vision_endpoint_id}
                onChange={(e) => {
                  set('vision_endpoint_id', e.target.value);
                  set('vision_model', '');
                }}
                className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
              >
                <option value="">None — visual agents can't see the screen</option>
                {endpoints.map((e) => (
                  <option key={e._id} value={e._id}>
                    {e.name}
                    {e.supports_vision ? '' : ' — not marked vision'}
                  </option>
                ))}
              </select>
              {form.vision_endpoint_id && (
                <select
                  value={form.vision_model}
                  onChange={(e) => set('vision_model', e.target.value)}
                  className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
                >
                  <option value="">Endpoint default</option>
                  {(endpoints.find((e) => e._id === form.vision_endpoint_id)?.models ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {form.vision_endpoint_id &&
              !endpoints.find((e) => e._id === form.vision_endpoint_id)?.supports_vision && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-400">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  This endpoint isn't marked <span className="font-medium">Model supports vision</span>{' '}
                  (below) — screenshots may not be interpreted. Tick it once you've launched it with a
                  vision model + <code>--mmproj</code>.
                </p>
              )}
          </Field>
          <Field
            label="Vision sampling"
            hint="Sampling for the vision analysis call. Leave a box blank to disable it — that parameter is then not sent, so the model server uses its own default."
          >
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              <NullableNumber label="temperature" value={form.vision_temperature} step={0.05} min={0} onChange={(v) => set('vision_temperature', v)} />
              <NullableNumber label="top_p" value={form.vision_top_p} step={0.05} min={0} max={1} onChange={(v) => set('vision_top_p', v)} />
              <NullableNumber label="max_tokens" value={form.vision_max_tokens} step={1} min={1} onChange={(v) => set('vision_max_tokens', v)} />
              <NullableNumber label="frequency_penalty" value={form.vision_frequency_penalty} step={0.1} onChange={(v) => set('vision_frequency_penalty', v)} />
              <NullableNumber label="presence_penalty" value={form.vision_presence_penalty} step={0.1} onChange={(v) => set('vision_presence_penalty', v)} />
            </div>
          </Field>
          <Field
            label="Image endpoint (for generate_image)"
            hint="The generate_image tool sends prompts here (POST /v1/images/generations). Point it at an OpenAI-compatible image server — e.g. the bundled image-gen/ stable-diffusion.cpp FLUX box. Per-image defaults (size/steps/guidance) live on the Tools page."
          >
            <div className="flex gap-2">
              <select
                value={form.image_endpoint_id}
                onChange={(e) => {
                  set('image_endpoint_id', e.target.value);
                  set('image_model', '');
                }}
                className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
              >
                <option value="">None — generate_image is unavailable</option>
                {endpoints.map((e) => (
                  <option key={e._id} value={e._id}>
                    {e.name}
                  </option>
                ))}
              </select>
              {form.image_endpoint_id && (
                <select
                  value={form.image_model}
                  onChange={(e) => set('image_model', e.target.value)}
                  className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
                >
                  <option value="">Endpoint default</option>
                  {(endpoints.find((e) => e._id === form.image_endpoint_id)?.models ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Field>
        </Section>

        {/* Fleet-wide AGENTS.md. Operator-owned: injected read-only into every agent's prompt. */}
        <Section
          icon={FileLock2}
          title="House rules (AGENTS.md)"
          subtitle="Standing instructions injected into every agent's prompt, subagents included. Agents cannot edit this — no tool writes it. Per-agent instructions live on each agent's page; the agent's own writable notes are its Notebook."
        >
          <Field
            label="AGENTS.md"
            hint="Markdown. Leave empty to inject nothing. Takes effect on each agent's next turn — no restart."
          >
            <textarea
              value={form.agents_md}
              onChange={(e) => set('agents_md', e.target.value)}
              rows={10}
              placeholder="# House rules&#10;- Rules every agent in this fleet must follow."
              className="w-full rounded-md border border-border bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            />
          </Field>
        </Section>

        {/* Conversation Quality Scorer — LLM-as-judge that rates each turn for the SFT dataset. */}
        <Section
          icon={Gauge}
          title="Conversation Quality Scorer"
          subtitle="Score each completed turn 0–100 + tag (Perfect/Patched/Recovered/Rejected) for the fine-tuning dataset. Manage scores on the Scoring page."
        >
          <Toggle
            label="Auto-score turns"
            hint="When on, every completed turn is scored automatically by the judge. Off → score only from the Scoring page (manual / batch)."
            checked={form.scoring_enabled}
            onChange={(v) => set('scoring_enabled', v)}
          />
          <Field
            label="Judge model"
            hint="The LLM-as-judge that rates turns. “Agent's own model” reuses the default endpoint; for reliable scores prefer a specific, capable endpoint (judged at temperature 0)."
          >
            <div className="flex gap-2">
              <select
                value={form.scoring_endpoint_id}
                onChange={(e) => {
                  set('scoring_endpoint_id', e.target.value);
                  set('scoring_model', '');
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
              {form.scoring_endpoint_id && (
                <select
                  value={form.scoring_model}
                  onChange={(e) => set('scoring_model', e.target.value)}
                  className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
                >
                  <option value="">Endpoint default</option>
                  {(endpoints.find((e) => e._id === form.scoring_endpoint_id)?.models ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Field>
          <Field
            label="Judge max tokens"
            hint="Token budget for the judge's reply. Reasoning judges spend tokens on a <think> block before the JSON verdict, so keep this ≥512."
          >
            <NumberInput
              value={form.scoring_max_tokens}
              min={64}
              step={1}
              onChange={(v) => set('scoring_max_tokens', v)}
            />
          </Field>
        </Section>

        {/* Long-term memory — post-turn distillation into the agent's Qdrant namespace. */}
        <Section
          icon={Brain}
          title="Long-term memory"
          subtitle="After a turn, the agent's own model rewrites what happened into standalone memories — most turns produce none. Inspect the result in the Memory Vault."
        >
          <Toggle
            label="Distil memories from turns"
            hint="When on, each completed turn costs one short extra completion, and what it teaches is stored as typed memories (facts, preferences, how-tos, episodes). Off → the agent only remembers what it deliberately saves with the `remember` tool."
            checked={form.memory_distill_enabled}
            onChange={(v) => set('memory_distill_enabled', v)}
          />
          <Field
            label="Distiller max tokens"
            hint="Token budget for the distiller's reply. It returns a small JSON object, but a reasoning model still needs room to think before it — keep this ≥512."
          >
            <NumberInput
              value={form.memory_max_tokens}
              min={128}
              step={1}
              onChange={(v) => set('memory_max_tokens', v)}
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

        {/* API Keys — read-only credentials for external consumers (scripts, MCP clients) */}
        <Section
          icon={KeyRound}
          title="API Keys"
          subtitle="Credentials for scripts and external agents (MCP, CLI). A key is read-only by default; grant it scopes (like agents:write) to unlock mutating methods on matching route families. Keys can't open a socket or manage keys."
        >
          <ApiKeysManager />
        </Section>

        {/* Backup & Transfer — export/import agents + isolations; export Qdrant memory (archival) */}
        <Section
          icon={DatabaseBackup}
          title="Backup & Transfer"
          subtitle="Export agents + isolations (and Qdrant memory) to a file, or import a config onto this instance."
        >
          <BackupTransfer />
        </Section>

        {/* Danger Zone — irreversible operational-data reset. Keeps agents/isolations/images/memory. */}
        <section className="rounded-lg border border-red-900/60 bg-surface">
          <div className="flex items-center gap-3 border-b border-red-900/60 px-5 py-3">
            <ShieldAlert size={16} className="text-red-400" />
            <div>
              <div className="text-sm font-semibold text-slate-100">Danger Zone</div>
              <div className="text-xs text-slate-500">
                Clear operational data. Agents, isolations, images and memory are kept.
              </div>
            </div>
          </div>
          <div className="p-5">
            <ClearDataPanel />
          </div>
        </section>

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
      downloadBlob(blob, `pleiades-${kind}-${stamp}.json`);
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
    if ((bundle as { type?: string })?.type !== 'pleiades-config') {
      setNote({ kind: 'err', text: 'Not a Pleiades config file (expected a pleiades-config export).' });
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

/** "never" / "3m ago" / "2d ago" — coarse enough that we never need to re-render on a timer. */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const scales: [number, string][] = [
    [60, 's'],
    [3600, 'm'],
    [86_400, 'h'],
  ];
  for (const [limit, unit] of scales) {
    if (seconds < limit) {
      const value = unit === 's' ? Math.floor(seconds) : Math.floor(seconds / (limit / 60));
      return `${value}${unit} ago`;
    }
  }
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * Mint / revoke / delete read-only API keys.
 *
 * The backend hashes the secret and returns the plaintext exactly once, in the create response — so
 * `issued` holds it in component state until the operator dismisses the callout, and it can never be
 * shown again. Revoking keeps the row (a dead key with an audit trail); deleting drops it entirely.
 */
function ApiKeysManager() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [agentsWrite, setAgentsWrite] = useState(false);
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () => apiKeysApi.list().then(setKeys);

  useEffect(() => {
    void reload().catch(() => setError('Failed to load API keys.'));
  }, []);

  async function create() {
    if (!name.trim()) return;
    setError(null);
    try {
      const key = await apiKeysApi.create(name.trim(), agentsWrite ? ['agents:write'] : []);
      setIssued({ name: key.name, key: key.key });
      setCopied(false);
      setName('');
      setAgentsWrite(false);
      setAdding(false);
      await reload();
    } catch {
      setError('Could not create the key.');
    }
  }

  async function revoke(k: ApiKey) {
    if (!confirm(`Revoke "${k.name}"? Anything using it stops working immediately.`)) return;
    await apiKeysApi.revoke(k._id);
    await reload();
  }

  async function remove(k: ApiKey) {
    if (!confirm(`Delete "${k.name}" permanently? This also drops its audit row.`)) return;
    await apiKeysApi.remove(k._id);
    await reload();
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }

  return (
    <div className="space-y-3">
      {/* Shown once, right after creation. The plaintext is unrecoverable once this is dismissed. */}
      {issued && (
        <div className="space-y-2 rounded-md border border-amber-900/60 bg-amber-950/20 p-3">
          <div className="flex items-start gap-1.5 text-xs text-amber-400">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              Copy <span className="font-medium">{issued.name}</span> now — this key is hashed at rest
              and will never be shown again.
            </span>
          </div>
          <div className="flex gap-2">
            <input
              readOnly
              value={issued.key}
              onFocus={(e) => e.target.select()}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-slate-200 outline-none"
            />
            <button
              onClick={() => void copy(issued.key)}
              className="flex items-center gap-1.5 rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-slate-200 hover:bg-surface"
            >
              {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button onClick={() => setIssued(null)} className="text-xs text-slate-400 hover:text-slate-200">
            I've saved it — dismiss
          </button>
        </div>
      )}

      {keys.map((k) => (
        <div key={k._id} className="flex items-center gap-3 rounded-md border border-border bg-panel p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`truncate text-sm font-medium ${k.revoked_at ? 'text-slate-500 line-through' : 'text-slate-200'}`}>
                {k.name}
              </span>
              {k.revoked_at && (
                <span className="shrink-0 rounded border border-red-900 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-400">
                  revoked
                </span>
              )}
              {k.scopes?.includes('agents:write') && (
                <span
                  title="This key can create, edit and delete agents"
                  className="shrink-0 rounded border border-amber-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-400"
                >
                  agents:write
                </span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
              <span className="font-mono">plk_{k.prefix}…</span>
              <span>last used {relativeTime(k.last_used_at)}</span>
              <span>created {relativeTime(k.created_at)}</span>
            </div>
          </div>
          {!k.revoked_at && (
            <button
              onClick={() => void revoke(k)}
              title="Revoke — the key stops working, the audit row stays"
              className="shrink-0 rounded p-1.5 text-slate-500 transition-colors hover:text-amber-400"
            >
              <Ban size={14} />
            </button>
          )}
          <button
            onClick={() => void remove(k)}
            title="Delete permanently"
            className="shrink-0 rounded p-1.5 text-slate-500 transition-colors hover:text-red-400"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}

      {keys.length === 0 && !adding && (
        <p className="text-xs text-slate-500">No API keys yet. Create one to let a script or agent read this instance.</p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      {adding ? (
        <div className="space-y-2 rounded-md border border-dashed border-border bg-panel p-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="Name (e.g. claude-code)"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          <label className="flex items-start gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={agentsWrite}
              onChange={(e) => setAgentsWrite(e.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span>
              Allow this key to <span className="text-slate-200">create, edit and delete agents</span>{' '}
              (<span className="font-mono">agents:write</span>). Leave off for a read-only key.
            </span>
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => void create()}
              disabled={!name.trim()}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              Create key
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setName('');
                setAgentsWrite(false);
              }}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-slate-400 transition-colors hover:text-slate-200"
        >
          <Plus size={13} /> Create API key
        </button>
      )}
    </div>
  );
}

/** Human labels for the raw collection keys returned by GET /maintenance/data-counts. */
const CLEAR_LABELS: Record<string, string> = {
  sessions: 'Sessions',
  messages: 'Messages',
  scores: 'Scores',
  llama_calls_debug: 'Inference logs (recent)',
  llama_calls_archive: 'Inference logs (archive)',
  notifications: 'Notifications',
  autonomy_run_results: 'Autonomy run history',
  finetune_jobs: 'Fine-tune job history',
};

const CLEAR_CATEGORIES: ResetCategory[] = ['conversations', 'scores', 'logs', 'activity'];

function flattenCounts(counts: DataCounts): { key: string; label: string; count: number }[] {
  const rows: { key: string; label: string; count: number }[] = [];
  for (const category of CLEAR_CATEGORIES) {
    for (const [key, count] of Object.entries(counts[category] ?? {})) {
      rows.push({ key, label: CLEAR_LABELS[key] ?? key, count });
    }
  }
  return rows;
}

/**
 * "Clear all data" — wipes conversations, scores, inference logs and activity records, keeping the
 * fleet (agents/isolations/images) and memory. Guarded by a type-CLEAR modal that first shows the
 * exact row counts, with an opt-in JSON backup downloaded before the wipe.
 */
function ClearDataPanel() {
  const [counts, setCounts] = useState<DataCounts | null>(null);
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [backup, setBackup] = useState(true);
  const [busy, setBusy] = useState<null | 'backup' | 'clear'>(null);
  const [result, setResult] = useState<ClearSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => maintenanceApi.counts().then(setCounts).catch(() => setError('Failed to load data counts.'));
  useEffect(() => {
    void reload();
  }, []);

  const rows = counts ? flattenCounts(counts) : [];
  const total = rows.reduce((n, r) => n + r.count, 0);

  function close() {
    setOpen(false);
    setConfirmText('');
    setError(null);
  }

  async function doClear() {
    if (confirmText !== 'CLEAR') return;
    setError(null);
    try {
      if (backup) {
        setBusy('backup');
        const blob = await maintenanceApi.exportBlob(CLEAR_CATEGORIES);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        downloadBlob(blob, `pleiades-data-backup-${stamp}.json`);
      }
      setBusy('clear');
      const summary = await maintenanceApi.clear(CLEAR_CATEGORIES);
      setResult(summary);
      close();
      await reload();
    } catch {
      setError('Clear failed — see server logs.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-slate-500">
          Deletes all conversations, scores, inference logs and activity records
          {total > 0 && <span className="text-slate-400"> ({total.toLocaleString()} rows)</span>}. This cannot be undone.
        </div>
        <button
          onClick={() => {
            setResult(null);
            setOpen(true);
          }}
          className="flex shrink-0 items-center gap-2 rounded-md border border-red-900 bg-red-950/30 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-950/60"
        >
          <Eraser size={15} /> Clear all data
        </button>
      </div>

      {result && (
        <div className="flex items-center gap-1.5 text-xs text-emerald-400">
          <Check size={14} /> Cleared {result.total.toLocaleString()} rows.
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={close}>
          <div
            className="w-full max-w-md space-y-4 rounded-lg border border-red-900/60 bg-surface p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-red-400">
              <ShieldAlert size={18} />
              <h3 className="text-sm font-semibold text-slate-100">Clear all data?</h3>
            </div>

            <p className="text-xs text-slate-400">
              This permanently deletes the following. Agents, isolations, images and memory are kept.
            </p>

            <div className="max-h-52 overflow-auto rounded-md border border-border bg-panel">
              {rows.length === 0 ? (
                <div className="px-3 py-2 text-xs text-slate-500">Nothing to clear.</div>
              ) : (
                rows.map((r) => (
                  <div key={r.key} className="flex justify-between px-3 py-1.5 text-xs">
                    <span className="text-slate-300">{r.label}</span>
                    <span className="font-mono text-slate-400">{r.count.toLocaleString()}</span>
                  </div>
                ))
              )}
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} className="accent-accent" />
              Download a JSON backup first
            </label>

            <div>
              <div className="mb-1 text-xs text-slate-400">
                Type <span className="font-mono font-semibold text-red-300">CLEAR</span> to confirm
              </div>
              <input
                autoFocus
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void doClear()}
                placeholder="CLEAR"
                className="w-full rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-red-500"
              />
            </div>

            {error && <p className="text-xs text-red-400">{error}</p>}

            <div className="flex justify-end gap-2">
              <button
                onClick={close}
                disabled={busy !== null}
                className="rounded-md border border-border px-3 py-2 text-sm text-slate-300 hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void doClear()}
                disabled={confirmText !== 'CLEAR' || busy !== null}
                className="flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-40"
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                {busy === 'backup' ? 'Backing up…' : busy === 'clear' ? 'Clearing…' : 'Clear data'}
              </button>
            </div>
          </div>
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
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      step={step}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-40 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

/**
 * A labelled number input that models a nullable value: an empty box means `null` (disabled → the
 * parameter is not sent to the model). Typing a number sets it; clearing the box disables it again.
 */
function NullableNumber({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[11px] text-slate-400">{label}</span>
      <input
        type="number"
        value={value ?? ''}
        placeholder="off"
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const t = e.target.value.trim();
          onChange(t === '' ? null : Number(t));
        }}
        className="w-full rounded-md border border-border bg-panel px-2 py-1.5 text-sm outline-none focus:border-accent"
      />
    </label>
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
 * Per-endpoint context-window control: pick how the meter's max is chosen (inherit the global
 * default / auto-detect / manual). In effective-auto it shows the real n_ctx probed for the
 * endpoint's default model (read-only); in manual it's an editable number. "Inherit" resolves auto
 * vs manual from the global toggle so the shown value always matches what the meter will use.
 */
function ContextWindowControl({
  endpoint: e,
  globalAuto,
  onPatch,
}: {
  endpoint: Endpoint;
  globalAuto: boolean;
  onPatch: (p: EndpointPatch) => void;
}) {
  const mode = e.context_window_mode ?? 'inherit';
  const effectiveAuto = mode === 'auto' || (mode !== 'manual' && globalAuto);
  const autoModel = e.default_model || e.models[0] || '';
  const probed = autoModel ? e.model_contexts?.[autoModel] : undefined;

  return (
    <div className="flex gap-2">
      <select
        value={mode}
        title="How this endpoint's context-meter max is chosen"
        onChange={(ev) => onPatch({ context_window_mode: ev.target.value as Endpoint['context_window_mode'] })}
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-slate-300 outline-none focus:border-accent"
      >
        <option value="inherit">Auto (global{globalAuto ? '' : ': manual'})</option>
        <option value="auto">Auto (this endpoint)</option>
        <option value="manual">Manual</option>
      </select>
      {effectiveAuto ? (
        <input
          type="text"
          readOnly
          value={probed ? `${probed.toLocaleString()} (auto)` : autoModel ? 'not probed — refresh models' : 'no model'}
          title={
            probed
              ? `Detected n_ctx for ${autoModel}`
              : 'Run "Refresh models" to probe this server\'s real n_ctx'
          }
          className="w-40 cursor-default rounded-md border border-border bg-panel px-2 py-1.5 text-sm text-slate-400 outline-none"
        />
      ) : (
        <input
          type="number"
          defaultValue={e.context_window}
          min={0}
          title="Manual context window (0 = use global)"
          onBlur={(ev) =>
            Number(ev.target.value) !== e.context_window &&
            void onPatch({ context_window: Number(ev.target.value) })
          }
          className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
        />
      )}
    </div>
  );
}

/**
 * Manage inference endpoints: add/edit URL+key, autodiscover the model list (`/v1/models`), pick
 * the fleet default, delete. Edits to an existing endpoint's fields save on blur; discovery and
 * default/delete apply immediately. `reload` re-pulls the list after every mutation.
 */
/**
 * CRUD for remote fine-tune servers. Mirrors `EndpointsManager` (edit-on-blur, confirm-to-delete),
 * with one difference: the API key is write-only. The backend stores it encrypted and never returns
 * it, so we render a password field that stays blank and only patches when the operator types a new
 * value (an explicit empty string clears the stored credential server-side).
 */
function FinetuneServersManager({
  servers,
  reload,
}: {
  servers: FinetuneServer[];
  reload: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || !url.trim()) return;
    setError(null);
    try {
      await finetuneServersApi.create({ name: name.trim(), base_url: url.trim(), api_key: apiKey || undefined });
      setName('');
      setUrl('');
      setApiKey('');
      setAdding(false);
      await reload();
    } catch {
      setError('Could not add the server — is the name already taken?');
    }
  }

  async function patch(id: string, p: FinetuneServerPatch) {
    await finetuneServersApi.update(id, p);
    await reload();
  }

  async function remove(s: FinetuneServer) {
    if (!confirm(`Delete fine-tune server "${s.name}"? Tracked jobs keep their history.`)) return;
    await finetuneServersApi.remove(s._id);
    await reload();
  }

  return (
    <div className="space-y-3">
      {servers.map((s) => (
        <div key={s._id} className="space-y-2 rounded-md border border-border bg-panel p-3">
          <div className="flex items-center gap-2">
            <input
              defaultValue={s.name}
              onBlur={(ev) => ev.target.value !== s.name && void patch(s._id, { name: ev.target.value })}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm font-medium outline-none focus:border-accent"
            />
            <button
              onClick={() => void patch(s._id, { enabled: !s.enabled })}
              title={s.enabled ? 'Disable (hide from Fine-Tuning page)' : 'Enable'}
              className={[
                'rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide',
                s.enabled
                  ? 'border-emerald-900 text-emerald-400'
                  : 'border-border text-slate-500 hover:text-slate-300',
              ].join(' ')}
            >
              {s.enabled ? 'enabled' : 'disabled'}
            </button>
            <button
              onClick={() => void remove(s)}
              title="Delete server"
              className="rounded p-1.5 text-slate-500 transition-colors hover:text-red-400"
            >
              <Trash2 size={14} />
            </button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <input
              defaultValue={s.base_url}
              onBlur={(ev) => ev.target.value !== s.base_url && void patch(s._id, { base_url: ev.target.value })}
              placeholder="http://192.168.1.30:8088"
              className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs outline-none focus:border-accent"
            />
            <input
              type="password"
              defaultValue=""
              placeholder={s.has_api_key ? '•••••••• (set — type to replace)' : 'API key (optional)'}
              onBlur={(ev) => {
                if (ev.target.value) {
                  void patch(s._id, { api_key: ev.target.value });
                  ev.target.value = '';
                }
              }}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-accent"
            />
          </div>
        </div>
      ))}

      {servers.length === 0 && !adding && (
        <p className="text-xs text-slate-500">
          No fine-tune servers yet. Add the base URL of a running fine-tune service.
        </p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      {adding ? (
        <div className="space-y-2 rounded-md border border-border bg-panel p-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. rig-01)"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://192.168.1.30:8088"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs outline-none focus:border-accent"
          />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API key (optional)"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            <button
              onClick={() => void create()}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
            >
              Add server
            </button>
            <button
              onClick={() => setAdding(false)}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-slate-400 transition-colors hover:text-slate-200"
        >
          <Plus size={13} /> Add fine-tune server
        </button>
      )}
    </div>
  );
}

function EndpointsManager({
  endpoints,
  reload,
  globalAuto,
}: {
  endpoints: Endpoint[];
  reload: () => Promise<void>;
  /** Fleet default for auto-detect, so an endpoint on `inherit` can show its effective resolved n_ctx. */
  globalAuto: boolean;
}) {
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
            <ContextWindowControl endpoint={e} globalAuto={globalAuto} onPatch={(p) => patch(e._id, p)} />
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

          {/* Vision marker: we can't autodiscover multimodality from /v1/models, so the operator
              declares it. Visual agents warn when paired with an endpoint that isn't ticked here. */}
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={Boolean(e.supports_vision)}
              onChange={(ev) => void patch(e._id, { supports_vision: ev.target.checked })}
              className="accent-accent"
            />
            <span>Model supports vision (multimodal)</span>
            <span className="text-slate-500">— llama.cpp launched with <code>--mmproj</code>, or a vision model</span>
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
