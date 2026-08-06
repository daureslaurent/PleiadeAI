import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  AudioLines,
  CheckCircle2,
  Clapperboard,
  Film,
  Download,
  ImagePlus,
  Pencil,
  RefreshCw,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  Button,
  Callout,
  EmptyState,
  Hint,
  Input,
  Section,
  Select,
  Spinner,
  Toggle,
} from '../components/ui';
import {
  mediaApi,
  type ComfyStatus,
  type DiscoveryCandidate,
  type MediaWorkflow,
  type MediaWorkflowDetail,
  type WorkflowBinding,
  type WorkflowKind,
} from '../lib/api';

const KIND_ICON: Record<WorkflowKind, typeof ImagePlus> = {
  image: ImagePlus,
  video: Clapperboard,
  audio: AudioLines,
  edit: Pencil,
  video_edit: Film,
};

/** The logical parameters a workflow can expose, in the order the editor lists them. */
const BINDING_KEYS = [
  'prompt',
  'negative_prompt',
  'seed',
  'width',
  'height',
  'length',
  'seconds',
  'fps',
  'batch',
  'image1',
  'image2',
  'image3',
  'audio1',
  'audio2',
  'video1',
  'filename_prefix',
] as const;

function secs(ms: number): string {
  if (!ms) return '—';
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * `/media` — the workflow library behind the media tools.
 *
 * Everything here exists because a ComfyUI workflow is a *graph*, not a prompt string: it has to be
 * discovered, snapshotted, and told which of its node inputs corresponds to "the prompt" before an
 * agent can drive it.
 */
export function MediaView() {
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  const [workflows, setWorkflows] = useState<MediaWorkflow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([mediaApi.status(), mediaApi.list()]);
      setStatus(s);
      setWorkflows(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setWorkflows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!workflows) return <Spinner />;

  return (
    <div className="animate-fade-up space-y-5 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-medium text-slate-100">Media workflows</h1>
        {status?.ok ? (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400">
            ComfyUI {status.version} · queue {status.queue_remaining}
          </span>
        ) : (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400">
            ComfyUI unreachable
          </span>
        )}
        <Button className="ml-auto" icon={<RefreshCw size={12} />} onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {error && (
        <Callout tone="error" icon={<AlertTriangle size={13} />}>
          {error}
        </Callout>
      )}
      {status && !status.ok && (
        <Callout tone="warn" icon={<AlertTriangle size={13} />}>
          {status.error} Set the server in Settings → Connections → ComfyUI server.
        </Callout>
      )}

      <Section title="Imported workflows" icon={<Wand2 size={13} />}>
        {workflows.length === 0 ? (
          <EmptyState icon={<Wand2 size={20} />}>
            Nothing imported yet — discover one below, then pick it per tool on the Tools page.
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {workflows.map((w) => (
              <WorkflowRow
                key={w.id}
                workflow={w}
                expanded={selected === w.id}
                onToggle={() => setSelected((s) => (s === w.id ? null : w.id))}
                onChanged={load}
              />
            ))}
          </div>
        )}
      </Section>

      <DiscoverPanel onImported={load} enabled={Boolean(status?.ok)} />
    </div>
  );
}

/** One stored workflow: summary row, expanding into the binding editor. */
function WorkflowRow({
  workflow,
  expanded,
  onToggle,
  onChanged,
}: {
  workflow: MediaWorkflow;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
}) {
  const Icon = KIND_ICON[workflow.kind];

  return (
    <div className="rounded-xl bg-black/25 ring-1 ring-white/[0.06]">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <Icon size={14} className="shrink-0 text-accent" />
        <button onClick={onToggle} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm text-slate-200">{workflow.name}</div>
          <div className="truncate text-[11px] text-slate-500">
            {workflow.kind} · {workflow.node_count} nodes · ~{secs(workflow.avg_duration_ms)}
            {workflow.unbound.length > 0 && (
              <span className="text-amber-400"> · unbound: {workflow.unbound.join(', ')}</span>
            )}
          </div>
        </button>
        {workflow.last_validation_error && (
          <AlertTriangle size={13} className="shrink-0 text-amber-400" />
        )}
        <Toggle
          checked={workflow.enabled}
          onChange={async (v) => {
            await mediaApi.update(workflow.id, { enabled: v });
            await onChanged();
          }}
        />
      </div>
      {expanded && <WorkflowDetail id={workflow.id} onChanged={onChanged} />}
    </div>
  );
}

/**
 * Binding editor.
 *
 * Auto-binding guesses well but cannot be trusted blindly — the same workflow can route its prompt
 * through an LLM expander, compute its frame count in a math node, or leave the only literal text on
 * the *negative* encoder. This is where the operator sees exactly which node input each parameter
 * writes to, and proves it with a test run rather than a hunch.
 */
function WorkflowDetail({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const [detail, setDetail] = useState<MediaWorkflowDetail | null>(null);
  const [bindings, setBindings] = useState<Record<string, WorkflowBinding>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[] | null>(null);
  const [testPrompt, setTestPrompt] = useState('a red apple on a white table');
  const [preview, setPreview] = useState<{ url: string; kind: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void mediaApi.get(id).then((d) => {
      setDetail(d);
      setBindings(d.bindings ?? {});
    });
  }, [id]);

  if (!detail) return <div className="px-3 pb-3"><Spinner /></div>;

  const setBinding = (key: string, nodeId: string, input: string) => {
    setBindings((b) => {
      const next = { ...b };
      if (!nodeId || !input) delete next[key];
      else next[key] = { node_id: nodeId, input };
      return next;
    });
  };

  const save = async () => {
    setBusy('save');
    try {
      await mediaApi.update(id, { bindings });
      setNote('Bindings saved.');
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  const validate = async () => {
    setBusy('validate');
    try {
      const res = await mediaApi.validate(id);
      setIssues(res.issues.map((i) => i.message));
      setNote(res.ok ? 'Valid — every node and model file is present on this ComfyUI.' : null);
      await onChanged();
    } catch (e) {
      setIssues([e instanceof Error ? e.message : 'Validation failed']);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setNote('Running… a video workflow can take many minutes.');
    setPreview(null);
    try {
      const res = await mediaApi.test(id, testPrompt);
      const file = res.files[0];
      if (file) setPreview({ url: mediaApi.viewUrl(file), kind: file.kind });
      setNote(`Done in ${secs(res.duration_ms)}.`);
      await onChanged();
    } catch (e) {
      setNote(null);
      setIssues([e instanceof Error ? e.message : 'Test run failed']);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 border-t border-white/[0.06] p-3">
      <div>
        <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">Parameter bindings</div>
        <div className="space-y-1.5">
          {BINDING_KEYS.map((key) => (
            <BindingRow
              key={key}
              label={key}
              binding={bindings[key]}
              nodes={detail.nodes}
              onChange={(nodeId, input) => setBinding(key, nodeId, input)}
            />
          ))}
        </div>
        <Hint>
          Binding an input that a node currently feeds is allowed — the tool's value simply wins and
          the upstream node stops mattering. Unbound parameters mean the matching Tools-page setting is
          ignored for this workflow.
        </Hint>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={busy === 'save'} onClick={() => void save()}>
          Save bindings
        </Button>
        <Button icon={<CheckCircle2 size={12} />} loading={busy === 'validate'} onClick={() => void validate()}>
          Validate
        </Button>
        <Button
          variant="danger"
          icon={<Trash2 size={12} />}
          onClick={async () => {
            await mediaApi.remove(id);
            await onChanged();
          }}
        >
          Delete
        </Button>
      </div>

      <div className="space-y-2 rounded-lg bg-black/20 p-2.5">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">Test run</div>
        <div className="flex gap-2">
          <Input value={testPrompt} onChange={(e) => setTestPrompt(e.target.value)} className="flex-1" />
          <Button variant="accentSoft" loading={busy === 'test'} onClick={() => void test()}>
            Run
          </Button>
        </div>
        <Hint>The only way to prove a prompt binding is right: run it and look at what comes back.</Hint>
        {preview && (
          <div className="pt-1">
            {preview.kind === 'video' ? (
              <video src={preview.url} controls className="max-h-64 rounded border border-border" />
            ) : preview.kind === 'audio' ? (
              <audio src={preview.url} controls className="w-full" />
            ) : (
              <img src={preview.url} alt="test render" className="max-h-64 rounded border border-border" />
            )}
          </div>
        )}
      </div>

      {note && <Hint>{note}</Hint>}
      {issues && issues.length > 0 && (
        <Callout tone="warn" icon={<AlertTriangle size={13} />}>
          <div className="space-y-1">
            {issues.map((m) => (
              <div key={m}>{m}</div>
            ))}
          </div>
        </Callout>
      )}
    </div>
  );
}

/** Node + input pickers for one logical parameter. */
function BindingRow({
  label,
  binding,
  nodes,
  onChange,
}: {
  label: string;
  binding?: WorkflowBinding;
  nodes: MediaWorkflowDetail['nodes'];
  onChange: (nodeId: string, input: string) => void;
}) {
  const node = nodes.find((n) => n.id === binding?.node_id);
  // Widget-typed inputs first: those are the ones that can actually hold a value.
  const inputs = [...(node?.inputs ?? [])].sort((a, b) =>
    a.type === 'LINK' && b.type !== 'LINK' ? 1 : a.type !== 'LINK' && b.type === 'LINK' ? -1 : 0,
  );

  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 truncate font-mono text-[11px] text-slate-400">{label}</span>
      <Select
        value={binding?.node_id ?? ''}
        onChange={(e) => onChange(e.target.value, '')}
        className="min-w-0 flex-1"
      >
        <option value="">— unbound —</option>
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.id} — {n.title}
          </option>
        ))}
      </Select>
      <Select
        value={binding?.input ?? ''}
        onChange={(e) => onChange(binding?.node_id ?? '', e.target.value)}
        disabled={!node}
        className="w-40 shrink-0"
      >
        <option value="">— input —</option>
        {inputs.map((i) => (
          <option key={i.name} value={i.name}>
            {i.name}
            {i.is_link ? ' (linked)' : ''}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * Import panel.
 *
 * Discovery reads ComfyUI's *run history*, which is the only place its graphs exist in the flat
 * "API format" that can be re-submitted — the workflows its editor saves reference subgraphs the
 * frontend has to expand. That history lives in RAM, so importing copies the graph here.
 */
function DiscoverPanel({ onImported, enabled }: { onImported: () => Promise<void>; enabled: boolean }) {
  const [candidates, setCandidates] = useState<DiscoveryCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});

  const probe = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await mediaApi.discover();
      setCandidates(found);
      setNames(Object.fromEntries(found.map((c) => [c.prompt_id, c.suggested_name])));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Discovery failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Discover from ComfyUI"
      icon={<Download size={13} />}
      right={
        <Button loading={busy} disabled={!enabled} onClick={() => void probe()}>
          {candidates ? 'Re-probe' : 'Discover'}
        </Button>
      }
    >
      <Hint>
        Every workflow you have run in ComfyUI shows up here. ComfyUI keeps that history in memory and
        loses it on restart — importing copies the graph into PleiadesAI, so the workflow keeps working
        afterwards. If the list is empty, run the workflow once in ComfyUI and re-probe.
      </Hint>

      {error && (
        <Callout tone="error" icon={<AlertTriangle size={13} />}>
          {error}
        </Callout>
      )}

      {candidates && candidates.length === 0 && (
        <EmptyState icon={<Download size={20} />}>ComfyUI has no runs in its history right now.</EmptyState>
      )}

      {candidates && candidates.length > 0 && (
        <div className="mt-2 space-y-2">
          {candidates.map((c) => {
            const Icon = KIND_ICON[c.kind];
            return (
              <div
                key={c.prompt_id}
                className="flex items-center gap-3 rounded-xl bg-black/25 px-3 py-2.5 ring-1 ring-white/[0.06]"
              >
                <Icon size={14} className="shrink-0 text-accent" />
                <div className="min-w-0 flex-1 space-y-1">
                  <Input
                    value={names[c.prompt_id] ?? c.suggested_name}
                    onChange={(e) => setNames((n) => ({ ...n, [c.prompt_id]: e.target.value }))}
                  />
                  <div className="truncate text-[11px] text-slate-500">
                    {c.kind} · {c.node_count} nodes · {c.run_count} run{c.run_count === 1 ? '' : 's'} ·{' '}
                    {secs(c.duration_ms)}
                    {c.status !== 'success' && <span className="text-amber-400"> · last run {c.status}</span>}
                    {c.unbound.length > 0 && (
                      <span className="text-amber-400"> · unbound: {c.unbound.join(', ')}</span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[10px] text-slate-600">
                    {/* Prefer showing where the name came from — a saved workflow file beats a
                        checkpoint filename as an identifier the operator recognises. */}
                    {c.source_file || c.model_files.slice(0, 2).join(', ')}
                  </div>
                </div>
                <Button
                  variant="accentSoft"
                  disabled={c.already_imported}
                  onClick={async () => {
                    await mediaApi.import({
                      prompt_id: c.prompt_id,
                      name: names[c.prompt_id] ?? c.suggested_name,
                      kind: c.kind,
                    });
                    await onImported();
                    await probe();
                  }}
                >
                  {c.already_imported ? 'Imported' : 'Import'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
