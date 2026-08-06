import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Play,
  Save,
  Trash2,
  Wand2,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { Button, Callout, Hint, Input, Select, Spinner, Textarea, Toggle, useConfirm } from '../../components/ui';
import {
  mediaApi,
  type BindingMeta,
  type MediaWorkflowDetail,
  type WorkflowBinding,
  type WorkflowKind,
} from '../../lib/api';
import { MappingCanvas } from './MappingCanvas';
import { MappingInspector } from './MappingInspector';

const KINDS: WorkflowKind[] = ['image', 'video', 'audio', 'edit', 'video_edit'];

const KIND_HINT: Record<WorkflowKind, string> = {
  image: 'Text → image. Offered to generate_image.',
  video: 'Text or a start frame → video. Offered to generate_video and animate_image.',
  audio: 'Text → sound. Offered to generate_sound.',
  edit: 'Image + instruction → image. Needs a Load Image node. Offered to edit_image.',
  video_edit: 'Video + instruction → video. Needs a Load Video node. Offered to edit_video.',
};

function secs(ms: number): string {
  if (!ms) return 'untimed';
  return ms >= 60_000 ? `~${Math.round(ms / 60_000)}m` : `~${(ms / 1000).toFixed(1)}s`;
}

/**
 * One workflow: what it is, who runs it, and how its inputs map onto the app's parameters.
 *
 * The draft (`bindings`, `output_node_id`, name/kind/description) is held locally and saved
 * explicitly. Binding is fiddly and often exploratory — auto-map, drag three wires, decide the second
 * one was wrong — and autosaving that would mean an agent could pick up a half-finished mapping
 * mid-edit.
 */
export function WorkflowDetail({
  id,
  onChanged,
  onDeleted,
}: {
  id: string;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const [detail, setDetail] = useState<MediaWorkflowDetail | null>(null);
  const [catalog, setCatalog] = useState<BindingMeta[]>([]);
  const [tab, setTab] = useState<'mapping' | 'run'>('mapping');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ level: string; message: string; node_id?: string }[] | null>(null);

  // The editable draft.
  const [name, setName] = useState('');
  const [kind, setKind] = useState<WorkflowKind>('image');
  const [description, setDescription] = useState('');
  const [bindings, setBindings] = useState<Record<string, WorkflowBinding>>({});
  const [outputNodeId, setOutputNodeId] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    const doc = await mediaApi.get(id);
    setDetail(doc);
    setName(doc.name);
    setKind(doc.kind);
    setDescription(doc.description);
    setBindings(doc.bindings ?? {});
    setOutputNodeId(doc.output_node_id);
    setDirty(false);
    setIssues(doc.last_validation_error ? [{ level: 'error', message: doc.last_validation_error }] : null);
  }, [id]);

  useEffect(() => {
    setDetail(null);
    setSelectedNodeId(null);
    setNote(null);
    void load();
  }, [load]);

  // The catalog's `expected` flags depend on the kind, so it is refetched when the operator re-kinds a
  // workflow — that is what moves `video1` from "extra" to "unbound and needed".
  useEffect(() => {
    void mediaApi.bindingKeys(kind).then(setCatalog);
  }, [kind]);

  const bind = useCallback((key: string, nodeId: string, input: string) => {
    setBindings((prev) => ({ ...prev, [key]: { node_id: nodeId, input } }));
    setDirty(true);
  }, []);

  const unbind = useCallback((key: string) => {
    setBindings((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setDirty(true);
  }, []);

  const pickOutput = useCallback((nodeId: string) => {
    setOutputNodeId(nodeId);
    setDirty(true);
  }, []);

  const selectedNode = useMemo(
    () => detail?.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [detail, selectedNodeId],
  );

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const save = async () => {
    setBusy('save');
    try {
      await mediaApi.update(id, { name, kind, description, bindings, output_node_id: outputNodeId });
      setNote('Saved.');
      setDirty(false);
      await onChanged();
      await load();
    } catch (e) {
      setIssues([{ level: 'error', message: e instanceof Error ? e.message : 'Save failed' }]);
    } finally {
      setBusy(null);
    }
  };

  const autoMap = async () => {
    setBusy('auto');
    try {
      const proposal = await mediaApi.autobind(id);
      const changed = Object.keys(proposal.bindings).filter(
        (key) =>
          bindings[key]?.node_id !== proposal.bindings[key]?.node_id ||
          bindings[key]?.input !== proposal.bindings[key]?.input,
      );
      setBindings(proposal.bindings);
      if (!outputNodeId) setOutputNodeId(proposal.output_node_id);
      setDirty(true);
      setNote(
        changed.length === 0
          ? 'Auto-map agrees with the current mapping.'
          : `Auto-map changed ${changed.length} binding${changed.length === 1 ? '' : 's'}: ${changed.join(', ')}. Review, then save.`,
      );
    } catch (e) {
      setIssues([{ level: 'error', message: e instanceof Error ? e.message : 'Auto-map failed' }]);
    } finally {
      setBusy(null);
    }
  };

  const validate = async () => {
    setBusy('validate');
    setNote(null);
    try {
      const res = await mediaApi.validate(id);
      setIssues(res.issues);
      if (res.ok) setNote('Valid — every node class and model file is present on this ComfyUI.');
      await onChanged();
      await load();
    } catch (e) {
      setIssues([{ level: 'error', message: e instanceof Error ? e.message : 'Validation failed' }]);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete "${detail.name}"?`,
      body:
        detail.consumers.length > 0
          ? `${detail.consumers.length} tool/flow node still selects it, and each will fail until you pick another workflow.`
          : 'The stored graph is deleted here. ComfyUI itself is untouched.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await mediaApi.remove(id);
    onDeleted();
    await onChanged();
  };

  const errors = issues?.filter((i) => i.level === 'error') ?? [];
  const warnings = issues?.filter((i) => i.level !== 'error') ?? [];

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header */}
      <div className="glass shrink-0 space-y-2.5 border-b p-3">
        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            className="min-w-0 flex-1 text-sm"
          />
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as WorkflowKind);
              setDirty(true);
            }}
            className="w-36 shrink-0"
            title={KIND_HINT[kind]}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          {/* Deliberately not followed by a reload: enabling is a one-field write, and refetching
              would throw away whatever mapping the operator has in flight. */}
          <Toggle
            checked={detail.enabled}
            onChange={async (v) => {
              setDetail((d) => (d ? { ...d, enabled: v } : d));
              await mediaApi.update(id, { enabled: v });
              await onChanged();
            }}
          />
        </div>

        <Input
          value={description}
          placeholder="What this workflow is for — shown to nobody but you."
          onChange={(e) => {
            setDescription(e.target.value);
            setDirty(true);
          }}
          className="text-xs"
        />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
          <span className="flex items-center gap-1">
            <WorkflowIcon size={10} /> {detail.node_count} nodes · {secs(detail.avg_duration_ms)}
          </span>
          {detail.models.length > 0 && (
            <span className="flex min-w-0 items-center gap-1" title={detail.models.join('\n')}>
              <Cpu size={10} />
              <span className="truncate font-mono">{detail.models[0]}</span>
              {detail.models.length > 1 && <span>+{detail.models.length - 1}</span>}
            </span>
          )}
          <span className="font-mono text-slate-600">{detail.source}</span>
        </div>

        <Consumers detail={detail} />

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg bg-black/25 p-0.5">
            {(['mapping', 'run'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-2.5 py-1 text-[11px] capitalize transition-colors ${
                  tab === t ? 'bg-accent/15 text-accent' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <Button icon={<Wand2 size={12} />} loading={busy === 'auto'} onClick={() => void autoMap()}>
            Auto-map
          </Button>
          <Button icon={<CheckCircle2 size={12} />} loading={busy === 'validate'} onClick={() => void validate()}>
            Validate
          </Button>
          <Button
            variant="primary"
            icon={<Save size={12} />}
            disabled={!dirty}
            loading={busy === 'save'}
            onClick={() => void save()}
          >
            {dirty ? 'Save changes' : 'Saved'}
          </Button>
          <Button className="ml-auto" variant="danger" icon={<Trash2 size={12} />} onClick={() => void remove()}>
            Delete
          </Button>
        </div>

        {note && <Hint>{note}</Hint>}
        {errors.length > 0 && (
          <Callout tone="error" icon={<AlertTriangle size={13} />}>
            <div className="space-y-1">
              {errors.map((i) => (
                <div key={i.message}>{i.message}</div>
              ))}
            </div>
          </Callout>
        )}
        {warnings.length > 0 && (
          <Callout tone="warn" icon={<AlertTriangle size={13} />}>
            <div className="space-y-1">
              {warnings.map((i) => (
                <div key={i.message}>{i.message}</div>
              ))}
            </div>
          </Callout>
        )}
      </div>

      {tab === 'mapping' ? (
        <div className="flex min-h-0 flex-1">
          <div className="h-full min-w-0 flex-1">
            <MappingCanvas
              nodes={detail.nodes}
              bindings={bindings}
              catalog={catalog}
              outputNodeId={outputNodeId}
              outputKind={detail.output_kind}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              onBind={bind}
              onUnbind={unbind}
              onOutputNode={pickOutput}
            />
          </div>
          <MappingInspector
            node={selectedNode}
            nodes={detail.nodes}
            catalog={catalog}
            bindings={bindings}
            outputNodeId={outputNodeId}
            onBind={bind}
            onUnbind={unbind}
            onOutputNode={pickOutput}
            onSelectNode={setSelectedNodeId}
          />
        </div>
      ) : (
        <RunPanel id={id} dirty={dirty} notes={detail.notes} onChanged={onChanged} />
      )}
    </div>
  );
}

/** Who runs this workflow — the answer that used to live three pages away. */
function Consumers({ detail }: { detail: MediaWorkflowDetail }) {
  if (detail.consumers.length === 0) {
    return (
      <div className="text-[10px] text-amber-400/90">
        Nothing runs this yet — select it on the Tools page, or on a media node in a flow.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-slate-500">Used by</span>
      {detail.consumers.map((c, i) => (
        <span
          key={`${c.kind}-${c.name}-${i}`}
          title={c.detail}
          className={`rounded-full px-1.5 py-0.5 text-[10px] ${
            c.kind === 'tool' ? 'bg-amber-500/10 text-amber-300' : 'bg-accent/10 text-accent'
          }`}
        >
          {c.kind === 'tool' ? `${c.name} (tool)` : `${c.name} · ${c.detail}`}
        </span>
      ))}
    </div>
  );
}

/**
 * Test run. The only way to prove a prompt binding: submit a sentence nothing in the graph could have
 * produced, and look at what comes back.
 */
function RunPanel({
  id,
  dirty,
  notes,
  onChanged,
}: {
  id: string;
  dirty: boolean;
  notes: string;
  onChanged: () => Promise<void>;
}) {
  const [prompt, setPrompt] = useState('a red apple on a white table');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; kind: string } | null>(null);
  const [draftNotes, setDraftNotes] = useState(notes);

  const run = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    setNote('Running… a video workflow can take many minutes.');
    try {
      const res = await mediaApi.test(id, prompt);
      const file = res.files[0];
      if (file) setPreview({ url: mediaApi.viewUrl(file), kind: file.kind });
      setNote(`Done in ${(res.duration_ms / 1000).toFixed(1)}s.`);
      await onChanged();
    } catch (e) {
      setNote(null);
      setError(e instanceof Error ? e.message : 'Test run failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="animate-fade-up mx-auto max-w-2xl space-y-4 p-4">
        <div className="space-y-2 rounded-xl bg-black/25 p-3 ring-1 ring-white/[0.06]">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Test run</div>
          {dirty && (
            <Callout tone="warn" icon={<AlertTriangle size={13} />}>
              Unsaved mapping changes — the test runs the <em>saved</em> bindings.
            </Callout>
          )}
          <div className="flex gap-2">
            <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} className="flex-1" />
            <Button variant="accentSoft" icon={<Play size={12} />} loading={busy} onClick={() => void run()}>
              Run
            </Button>
          </div>
          <Hint>
            Use a prompt the workflow's author never would have — if the result ignores it, the prompt
            binding is pointing at the wrong node.
          </Hint>
          {note && <Hint>{note}</Hint>}
          {error && (
            <Callout tone="error" icon={<AlertTriangle size={13} />}>
              {error}
            </Callout>
          )}
          {preview && (
            <div className="pt-1">
              {preview.kind === 'video' ? (
                <video src={preview.url} controls className="max-h-96 rounded-lg ring-1 ring-white/[0.08]" />
              ) : preview.kind === 'audio' ? (
                <audio src={preview.url} controls className="w-full" />
              ) : (
                <img
                  src={preview.url}
                  alt="test render"
                  className="max-h-96 rounded-lg ring-1 ring-white/[0.08]"
                />
              )}
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-xl bg-black/25 p-3 ring-1 ring-white/[0.06]">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Notes</div>
          <Textarea
            rows={4}
            value={draftNotes}
            onChange={(e) => setDraftNotes(e.target.value)}
            placeholder="What this graph is good at, what its quirks are, which prompts work."
          />
          <Button
            onClick={async () => {
              await mediaApi.update(id, { notes: draftNotes });
              await onChanged();
            }}
          >
            Save notes
          </Button>
        </div>
      </div>
    </div>
  );
}
