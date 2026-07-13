import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Brain, Download, Upload } from 'lucide-react';
import { Button, useConfirm } from '../../../components/ui';
import { agentsApi, transferApi, type Agent, type ImportSummary } from '../../../lib/api';

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Export/import panel. Export operates on a selectable subset of agents (with a select-all); the
 * referenced isolations + Qdrant namespaces are pulled in automatically by the backend. Import reads
 * a previously exported *config* file (agents + isolations) — memory is not re-imported — and
 * overwrites any same-named agent/isolation.
 */
export function BackupTransfer() {
  const confirm = useConfirm();
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
        kind === 'config' ? await transferApi.exportConfig(ids, all) : await transferApi.exportMemory(ids, all);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(blob, `pleiades-${kind}-${stamp}.json`);
      setNote({
        kind: 'ok',
        text: `${kind === 'config' ? 'Config' : 'Memory'} exported (${ids.length} agent${ids.length === 1 ? '' : 's'}).`,
      });
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
    const ok = await confirm({
      title: `Import ${agentCount} agent(s) and their isolations?`,
      body: 'Any agent or isolation with the same name will be OVERWRITTEN.',
      confirmLabel: 'Import',
      danger: true,
    });
    if (!ok) return;

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
          <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Agents to export</div>
          <button onClick={toggleAll} className="text-[11px] text-accent hover:underline">
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>
        <div className="max-h-44 overflow-auto rounded-xl border border-white/[0.06] bg-black/25 p-1">
          {agents.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-slate-500">No agents.</div>
          ) : (
            agents.map((a) => (
              <label
                key={a._id}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-300 transition-colors hover:bg-white/[0.05]"
              >
                <input
                  type="checkbox"
                  checked={selected.has(a._id)}
                  onChange={() => toggle(a._id)}
                  className="h-3.5 w-3.5 cursor-pointer rounded border-white/20 bg-black/30 accent-accent"
                />
                <span className="truncate">{a.name}</span>
                {a.isolation_id && (
                  <span className="ml-auto shrink-0 rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-slate-500">
                    isolated
                  </span>
                )}
              </label>
            ))
          )}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
          Referenced isolations and Qdrant namespaces are included automatically. Secrets (SSH private
          keys, secret-looking parameter values) are stripped from exports.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void doExport('config')} disabled={busy !== null} loading={busy === 'config'} icon={<Download size={13} />}>
          Export config
        </Button>
        <Button onClick={() => void doExport('memory')} disabled={busy !== null} loading={busy === 'memory'} icon={<Brain size={13} />}>
          Export memory
        </Button>
      </div>

      <div className="border-t border-white/[0.06] pt-4">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">Import config</div>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={onImportFile} className="hidden" />
        <Button
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          loading={busy === 'import'}
          icon={<Upload size={13} />}
        >
          Choose config file…
        </Button>
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-400/80">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>Same-named agents and isolations are overwritten. Memory dumps cannot be imported.</span>
        </p>
      </div>

      {note && (
        <p className={`text-[11px] ${note.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>{note.text}</p>
      )}
      {summary && (
        <div className="rounded-xl border border-white/[0.06] bg-black/25 p-3 text-[11px] text-slate-400">
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
