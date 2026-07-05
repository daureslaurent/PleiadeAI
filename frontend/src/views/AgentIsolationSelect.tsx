import { useEffect, useState } from 'react';
import { HardDrive, Power, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  agentsApi,
  isolationsApi,
  type AgentContainerStatus,
  type Isolation,
} from '../lib/api';

/**
 * Assigns an agent to a shared isolation profile (or none) and manages its individual container.
 * Changes apply immediately (like the parameter grid). The profile/image itself is managed on the
 * Isolation page — here you only pick one and choose the workspace volume scope.
 */
export function AgentIsolationSelect({
  agentId,
  isolationId,
  volumeMode,
}: {
  agentId: string;
  isolationId: string | null;
  volumeMode: 'individual' | 'shared';
}) {
  const [profiles, setProfiles] = useState<Isolation[]>([]);
  const [selected, setSelected] = useState<string>(isolationId ?? '');
  const [mode, setMode] = useState<'individual' | 'shared'>(volumeMode);
  const [status, setStatus] = useState<AgentContainerStatus | null>(null);
  const [busy, setBusy] = useState(false);

  async function refreshStatus() {
    setStatus(await agentsApi.container(agentId).catch(() => null));
  }

  useEffect(() => {
    void isolationsApi.list().then(setProfiles);
  }, []);

  useEffect(() => {
    setSelected(isolationId ?? '');
    setMode(volumeMode);
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, isolationId, volumeMode]);

  async function apply(next: { isolation_id?: string | null; isolation_volume_mode?: 'individual' | 'shared' }) {
    setBusy(true);
    try {
      await agentsApi.update(agentId, next);
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  function onSelect(id: string) {
    setSelected(id);
    void apply({ isolation_id: id || null });
  }
  function onMode(m: 'individual' | 'shared') {
    setMode(m);
    void apply({ isolation_volume_mode: m });
  }

  const active = profiles.find((p) => p._id === selected);
  const notBuilt = active && status?.image_status !== 'built';

  return (
    <div className="space-y-3 rounded-md border border-border bg-panel p-4">
      <div className="flex items-center gap-3">
        <select
          value={selected}
          disabled={busy}
          onChange={(e) => onSelect(e.target.value)}
          className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        >
          <option value="">No isolation — run on backend</option>
          {profiles.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>
        {active && <ContainerBadge status={status} />}
      </div>

      {!active ? (
        <p className="text-xs text-slate-500">
          The agent’s <code>bash</code> and skills run in the backend container. Assign a profile to
          isolate them. Manage profiles on the{' '}
          <Link to="/isolation" className="text-accent hover:underline">
            Isolation
          </Link>{' '}
          page.
        </p>
      ) : (
        <>
          {/* Volume scope */}
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1.5 text-slate-400">
              <HardDrive size={13} /> Workspace
            </span>
            {(['individual', 'shared'] as const).map((m) => (
              <label key={m} className="flex items-center gap-1.5 text-slate-300">
                <input
                  type="radio"
                  name={`vol-${agentId}`}
                  checked={mode === m}
                  disabled={busy}
                  onChange={() => onMode(m)}
                  className="accent-accent"
                />
                {m === 'individual' ? 'Individual (private)' : 'Shared (across profile)'}
              </label>
            ))}
          </div>

          {notBuilt && (
            <p className="text-xs text-amber-400">
              Image not built yet — build it on the{' '}
              <Link to="/isolation" className="underline">
                Isolation
              </Link>{' '}
              page, or bash/skills will error.
            </p>
          )}

          {/* Container controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => agentsApi.stopContainer(agentId).then(refreshStatus)}
              disabled={status?.container_state !== 'running'}
              className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-xs text-slate-300 disabled:opacity-40"
            >
              <Power size={13} /> Stop container
            </button>
            <button
              onClick={async () => {
                if (mode !== 'individual') return;
                if (!confirm('Delete this agent’s workspace volume? Files in /workspace are lost.')) return;
                await agentsApi.deleteVolume(agentId);
                await refreshStatus();
              }}
              disabled={mode !== 'individual' || !status?.individual_volume_exists}
              className="flex items-center gap-1 rounded border border-red-900 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950 disabled:opacity-40"
              title={mode !== 'individual' ? 'Shared volumes are managed on the Isolation page' : ''}
            >
              <Trash2 size={13} /> Delete volume
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ContainerBadge({ status }: { status: AgentContainerStatus | null }) {
  const state = status?.container_state ?? '…';
  const color =
    state === 'running'
      ? 'text-emerald-400 border-emerald-900'
      : state === 'absent'
        ? 'text-slate-500 border-border'
        : 'text-amber-400 border-amber-900';
  return (
    <span className={`shrink-0 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ${color}`}>
      container: {state}
    </span>
  );
}
