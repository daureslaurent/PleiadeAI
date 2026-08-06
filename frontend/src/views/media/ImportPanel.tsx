import { useRef, useState } from 'react';
import { AlertTriangle, ClipboardPaste, Download, FileJson, RefreshCw } from 'lucide-react';
import { Button, Callout, EmptyState, Hint, Input, Select, Spinner, Textarea } from '../../components/ui';
import { mediaApi, type DiscoveryCandidate, type WorkflowKind } from '../../lib/api';

const KINDS: WorkflowKind[] = ['image', 'video', 'audio', 'edit', 'video_edit'];

function secs(ms: number): string {
  if (!ms) return '—';
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The two ways a workflow gets in.
 *
 * *Discover* reads ComfyUI's run history, which is the only place its graphs exist in the flat API
 * format that can be re-submitted. *Paste* takes the file ComfyUI's own **Workflow → Export (API)**
 * writes — which is what you have for a graph you downloaded, or one that ran on a server you can't
 * reach from here. Both land in the same place: a snapshot in Mongo that survives a ComfyUI restart.
 */
export function ImportPanel({
  comfyOnline,
  onImported,
  onClose,
}: {
  comfyOnline: boolean;
  onImported: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'discover' | 'paste'>(comfyOnline ? 'discover' : 'paste');

  return (
    <div className="animate-fade-up glass-card m-3 rounded-2xl p-3">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-black/25 p-0.5">
          <button
            onClick={() => setMode('discover')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-colors ${
              mode === 'discover' ? 'bg-accent/15 text-accent' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Download size={11} /> Discover from ComfyUI
          </button>
          <button
            onClick={() => setMode('paste')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-colors ${
              mode === 'paste' ? 'bg-accent/15 text-accent' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileJson size={11} /> Paste API JSON
          </button>
        </div>
        <Button className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>

      {mode === 'discover' ? (
        <DiscoverTab enabled={comfyOnline} onImported={onImported} />
      ) : (
        <PasteTab onImported={onImported} />
      )}
    </div>
  );
}

function DiscoverTab({
  enabled,
  onImported,
}: {
  enabled: boolean;
  onImported: (id: string) => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<DiscoveryCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
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
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Hint>
          Every workflow you have run in ComfyUI shows up here. That history lives in memory and is lost
          on restart — importing copies the graph into PleiadesAI, so the workflow keeps working
          afterwards. Empty list? Run the workflow once in ComfyUI and re-probe.
        </Hint>
        <Button
          className="ml-auto"
          icon={<RefreshCw size={12} />}
          loading={busy}
          disabled={!enabled}
          onClick={() => void probe()}
        >
          {candidates ? 'Re-probe' : 'Discover'}
        </Button>
      </div>

      {!enabled && (
        <Callout tone="warn" icon={<AlertTriangle size={13} />}>
          ComfyUI is unreachable, so its history can't be read. Paste an exported API JSON instead — that
          path needs no server.
        </Callout>
      )}
      {error && (
        <Callout tone="error" icon={<AlertTriangle size={13} />}>
          {error}
        </Callout>
      )}
      {busy && !candidates && <Spinner />}
      {candidates?.length === 0 && (
        <EmptyState icon={<Download size={20} />}>ComfyUI has no runs in its history right now.</EmptyState>
      )}

      <div className="grid gap-2 md:grid-cols-2">
        {candidates?.map((c) => (
          <div
            key={c.prompt_id}
            className="space-y-1.5 rounded-xl bg-black/25 p-2.5 ring-1 ring-white/[0.06] transition-shadow hover:ring-white/[0.12]"
          >
            <Input
              value={names[c.prompt_id] ?? c.suggested_name}
              onChange={(e) => setNames((n) => ({ ...n, [c.prompt_id]: e.target.value }))}
            />
            <div className="text-[10px] text-slate-500">
              {c.kind} · {c.node_count} nodes · {c.run_count} run{c.run_count === 1 ? '' : 's'} ·{' '}
              {secs(c.duration_ms)}
              {c.status !== 'success' && <span className="text-amber-400"> · last run {c.status}</span>}
              {c.unbound.length > 0 && (
                <span className="text-amber-400"> · unbound: {c.unbound.join(', ')}</span>
              )}
            </div>
            <div className="truncate font-mono text-[10px] text-slate-600" title={c.model_files.join('\n')}>
              {/* A saved workflow file beats a checkpoint filename as an identifier the operator recognises. */}
              {c.source_file || c.model_files.slice(0, 2).join(', ')}
            </div>
            <Button
              variant="accentSoft"
              className="w-full"
              disabled={c.already_imported}
              loading={importing === c.prompt_id}
              onClick={async () => {
                setImporting(c.prompt_id);
                try {
                  const doc = await mediaApi.import({
                    prompt_id: c.prompt_id,
                    name: names[c.prompt_id] ?? c.suggested_name,
                    kind: c.kind,
                  });
                  await onImported(doc.id);
                  await probe();
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Import failed');
                } finally {
                  setImporting(null);
                }
              }}
            >
              {c.already_imported ? 'Already imported' : 'Import'}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Paste or drop the file ComfyUI's *Export (API)* writes. Works with the server offline. */
function PasteTab({ onImported }: { onImported: (id: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'' | WorkflowKind>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const take = async (file: File) => {
    setText(await file.text());
    if (!name) setName(file.name.replace(/\.json$/i, '').replace(/[_-]+/g, ' '));
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const graph = JSON.parse(text) as unknown;
      const doc = await mediaApi.create({
        name: name.trim() || 'Pasted workflow',
        graph,
        ...(kind ? { kind } : {}),
      });
      setText('');
      setName('');
      await onImported(doc.id);
    } catch (e) {
      setError(
        e instanceof SyntaxError
          ? "That isn't valid JSON — paste the whole file, including its outermost { }."
          : e instanceof Error
            ? e.message
            : 'Import failed',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Hint>
        In ComfyUI: <span className="font-mono text-slate-400">Workflow → Export (API)</span>. The
        editor's ordinary save format won't work — it references subgraphs that only its own frontend
        can expand, and it can't be submitted.
      </Hint>

      <div className="flex gap-2">
        <Input
          value={name}
          placeholder="Name"
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1"
        />
        <Select value={kind} onChange={(e) => setKind(e.target.value as WorkflowKind | '')} className="w-40 shrink-0">
          <option value="">kind: auto-detect</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) void take(file);
        }}
        className={`rounded-xl border border-dashed p-2 transition-colors ${
          dragging ? 'border-accent/60 bg-accent/[0.06]' : 'border-white/[0.12]'
        }`}
      >
        <Textarea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='Drop workflow_api.json here, or paste it:  { "3": { "class_type": "KSampler", … } }'
          className="font-mono text-[11px]"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void take(file);
            }}
          />
          <Button icon={<FileJson size={12} />} onClick={() => fileInput.current?.click()}>
            Choose file
          </Button>
          <Button
            variant="primary"
            icon={<ClipboardPaste size={12} />}
            disabled={!text.trim()}
            loading={busy}
            onClick={() => void submit()}
          >
            Import
          </Button>
        </div>
      </div>

      {error && (
        <Callout tone="error" icon={<AlertTriangle size={13} />}>
          {error}
        </Callout>
      )}
    </div>
  );
}
