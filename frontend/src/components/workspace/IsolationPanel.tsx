import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Box,
  ChevronRight,
  Cpu,
  Download,
  File as FileIcon,
  FileText,
  Folder,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  Play,
  RotateCw,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  agentsApi,
  type Agent,
  type AgentContainerStatus,
  type ContainerFile,
  type ContainerFilePreview,
  type ContainerStats,
} from '../../lib/api';

const ROOT = '/workspace';
const REFRESH_MS = 3000;

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtTime(epochSec: number): string {
  if (!epochSec) return '';
  const d = new Date(epochSec * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Read `error` code off an axios error without pulling axios types in. */
function errCode(e: unknown): string | null {
  const r = (e as { response?: { data?: { error?: string } } })?.response;
  return r?.data?.error ?? null;
}

interface Props {
  agent: Agent | null;
}

/**
 * Debugger → Isolation tab. For the active agent's assigned isolation container, surfaces live
 * resource usage and a `/workspace` file explorer (view / download / upload / delete), plus
 * lifecycle controls. Falls back to a guided empty state when the agent isn't isolated.
 */
export function IsolationPanel({ agent }: Props) {
  const [status, setStatus] = useState<AgentContainerStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const agentId = agent?._id ?? null;

  const loadStatus = useCallback(async () => {
    if (!agentId) return;
    setStatusLoading(true);
    try {
      setStatus(await agentsApi.container(agentId));
    } catch {
      setStatus(null);
    } finally {
      setStatusLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setStatus(null);
    void loadStatus();
  }, [loadStatus]);

  const isolated = !!status?.isolation_id;
  const running = status?.container_state === 'running';

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
      await loadStatus();
    } catch (e) {
      if (errCode(e) === 'not_ready') {
        alert('Container image is not built. Build it on the Isolation page first.');
      }
    } finally {
      setBusy(null);
    }
  }

  if (!agent) {
    return <Centered>Select a session to inspect its agent’s isolation.</Centered>;
  }

  if (statusLoading && !status) {
    return (
      <Centered>
        <Loader2 size={22} className="animate-spin text-slate-600" />
      </Centered>
    );
  }

  if (!isolated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-slate-500">
        <Box size={30} className="text-slate-700" />
        <p className="text-sm font-medium text-slate-400">No isolation profile</p>
        <p className="text-xs leading-relaxed">
          <span className="text-slate-300">{agent.name}</span> runs on the backend. Assign an
          isolation profile on the <span className="text-slate-300">Agents</span> page to give it a
          dedicated container with its own filesystem.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Container header + lifecycle controls */}
      <div className="border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Box size={15} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
            {status?.isolation_name}
          </span>
          <StateBadge state={status?.container_state ?? 'absent'} />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {running ? (
            <>
              <CtrlBtn
                icon={RotateCw}
                label="Restart"
                busy={busy === 'restart'}
                onClick={() =>
                  act('restart', async () => {
                    await agentsApi.stopContainer(agent._id);
                    await agentsApi.startContainer(agent._id);
                  })
                }
              />
              <CtrlBtn
                icon={Square}
                label="Stop"
                busy={busy === 'stop'}
                onClick={() => act('stop', () => agentsApi.stopContainer(agent._id))}
              />
            </>
          ) : (
            <CtrlBtn
              icon={Play}
              label="Start"
              accent
              busy={busy === 'start'}
              onClick={() => act('start', () => agentsApi.startContainer(agent._id))}
            />
          )}
          {status?.volume_mode === 'individual' && status.individual_volume_exists && (
            <CtrlBtn
              icon={Trash2}
              label="Wipe volume"
              danger
              busy={busy === 'volume'}
              onClick={() =>
                confirm('Delete this agent’s workspace volume? All files are lost permanently.') &&
                act('volume', () => agentsApi.deleteVolume(agent._id))
              }
            />
          )}
        </div>
      </div>

      {running ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <UsageStrip agentId={agent._id} />
          <FileExplorer agentId={agent._id} />
        </div>
      ) : (
        <Centered>
          <Play size={26} className="mb-1 text-slate-700" />
          <p className="text-sm">Container is {status?.container_state ?? 'stopped'}.</p>
          <p className="text-xs text-slate-600">Start it to browse files and view usage.</p>
        </Centered>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- usage ---- */

function UsageStrip({ agentId }: { agentId: string }) {
  const [stats, setStats] = useState<ContainerStats | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      agentsApi
        .containerStats(agentId)
        .then((s) => alive && setStats(s))
        .catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [agentId]);

  const memPerc = stats?.mem_perc ? parseFloat(stats.mem_perc) : 0;

  return (
    <div className="grid grid-cols-2 gap-1.5 border-b border-border p-2.5">
      <Stat icon={Cpu} label="CPU" value={stats?.cpu_perc ?? '—'} />
      <Stat icon={HardDrive} label="Disk" value={fmtBytes(stats?.workspace_bytes ?? 0)} />
      <div className="col-span-2 rounded-lg bg-panel px-2.5 py-1.5 ring-1 ring-border">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500">
          <MemoryStick size={12} /> Memory
          <span className="ml-auto font-mono text-[11px] text-slate-300">
            {stats?.mem_usage ?? '—'}
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${Math.min(100, memPerc)}%` }}
          />
        </div>
      </div>
      <Stat icon={Network} label="Net I/O" value={stats?.net_io ?? '—'} mono small />
      <Stat icon={HardDrive} label="Block I/O" value={stats?.block_io ?? '—'} mono small />
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  mono,
  small,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg bg-panel px-2.5 py-1.5 ring-1 ring-border">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500">
        <Icon size={12} /> {label}
      </div>
      <div
        className={`mt-0.5 truncate text-slate-200 ${mono ? 'font-mono' : 'font-semibold'} ${
          small ? 'text-[11px]' : 'text-sm'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- explorer ---- */

function FileExplorer({ agentId }: { agentId: string }) {
  const [path, setPath] = useState(ROOT);
  const [entries, setEntries] = useState<ContainerFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ContainerFilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (p: string) => {
      setLoading(true);
      setError(null);
      try {
        const { entries } = await agentsApi.listFiles(agentId, p);
        setEntries(entries);
        setPath(p);
      } catch (e) {
        setError(errCode(e) === 'not_running' ? 'Container stopped.' : 'Failed to list directory.');
      } finally {
        setLoading(false);
      }
    },
    [agentId],
  );

  useEffect(() => {
    void load(ROOT);
  }, [load]);

  async function openFile(entry: ContainerFile) {
    const full = `${path}/${entry.name}`;
    setPreviewLoading(true);
    try {
      setPreview(await agentsApi.readFile(agentId, full));
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function del(entry: ContainerFile) {
    if (!confirm(`Delete ${entry.name}? This cannot be undone.`)) return;
    await agentsApi.deleteFile(agentId, `${path}/${entry.name}`).catch(() => undefined);
    await load(path);
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await agentsApi.uploadFile(agentId, `${path}/${file.name}`, file);
      await load(path);
    } catch {
      alert('Upload failed.');
    }
  }

  // Breadcrumb segments relative to the workspace root.
  const rel = path === ROOT ? [] : path.slice(ROOT.length + 1).split('/');

  if (preview || previewLoading) {
    return (
      <FilePreview
        preview={preview}
        loading={previewLoading}
        onBack={() => setPreview(null)}
        onDownload={() => preview && agentsApi.downloadFile(agentId, preview.path)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar: breadcrumb + upload */}
      <div className="flex items-center gap-1 border-b border-border px-2.5 py-1.5 text-xs">
        <button
          onClick={() => load(ROOT)}
          className="rounded px-1 py-0.5 text-slate-400 hover:bg-panel hover:text-slate-200"
        >
          workspace
        </button>
        {rel.map((seg, i) => (
          <span key={i} className="flex min-w-0 items-center gap-1">
            <ChevronRight size={12} className="shrink-0 text-slate-600" />
            <button
              onClick={() => load(`${ROOT}/${rel.slice(0, i + 1).join('/')}`)}
              className="truncate rounded px-1 py-0.5 text-slate-300 hover:bg-panel"
            >
              {seg}
            </button>
          </span>
        ))}
        <button
          onClick={() => uploadRef.current?.click()}
          title="Upload file here"
          className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-slate-400 hover:bg-panel hover:text-slate-200"
        >
          <Upload size={13} /> Upload
        </button>
        <input ref={uploadRef} type="file" className="hidden" onChange={onUpload} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 size={18} className="animate-spin text-slate-600" />
          </div>
        ) : error ? (
          <p className="px-2 py-4 text-center text-xs text-slate-500">{error}</p>
        ) : entries.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-slate-600">Empty directory.</p>
        ) : (
          entries.map((entry) => (
            <Row
              key={entry.name}
              entry={entry}
              onOpen={() =>
                entry.type === 'dir' ? load(`${path}/${entry.name}`) : openFile(entry)
              }
              onDownload={
                entry.type === 'file'
                  ? () => agentsApi.downloadFile(agentId, `${path}/${entry.name}`)
                  : undefined
              }
              onDelete={() => del(entry)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Row({
  entry,
  onOpen,
  onDownload,
  onDelete,
}: {
  entry: ContainerFile;
  onOpen: () => void;
  onDownload?: () => void;
  onDelete: () => void;
}) {
  const isDir = entry.type === 'dir';
  const Icon = isDir ? Folder : entry.type === 'link' ? FileIcon : FileText;
  return (
    <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon size={14} className={`shrink-0 ${isDir ? 'text-accent' : 'text-slate-400'}`} />
        <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{entry.name}</span>
        {!isDir && <span className="shrink-0 text-[10px] text-slate-600">{fmtBytes(entry.size)}</span>}
        <span className="hidden shrink-0 text-[10px] text-slate-600 sm:inline">{fmtTime(entry.mtime)}</span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {onDownload && (
          <button
            onClick={onDownload}
            title="Download"
            className="rounded p-1 text-slate-500 hover:bg-surface hover:text-slate-200"
          >
            <Download size={13} />
          </button>
        )}
        <button
          onClick={onDelete}
          title="Delete"
          className="rounded p-1 text-slate-500 hover:bg-surface hover:text-red-400"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function FilePreview({
  preview,
  loading,
  onBack,
  onDownload,
}: {
  preview: ContainerFilePreview | null;
  loading: boolean;
  onBack: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
        <button
          onClick={onBack}
          className="rounded p-1 text-slate-400 hover:bg-panel hover:text-slate-200"
        >
          <ArrowLeft size={15} />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200">
          {preview ? preview.path.split('/').pop() : ''}
        </span>
        {preview && (
          <>
            <span className="shrink-0 text-[10px] text-slate-600">{fmtBytes(preview.size)}</span>
            <button
              onClick={onDownload}
              title="Download"
              className="rounded p-1 text-slate-500 hover:bg-panel hover:text-slate-200"
            >
              <Download size={13} />
            </button>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 size={18} className="animate-spin text-slate-600" />
          </div>
        ) : preview?.binary ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-slate-500">
            <FileIcon size={26} className="text-slate-700" />
            <p className="text-xs">Binary file — not previewable.</p>
            <button onClick={onDownload} className="text-xs text-accent hover:underline">
              Download instead
            </button>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-300">
            {preview?.content}
            {preview?.truncated && (
              <span className="mt-2 block text-[10px] italic text-slate-600">
                … preview truncated (file is larger than 512 KB — download for the full contents).
              </span>
            )}
          </pre>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- shared ---- */

function StateBadge({ state }: { state: string }) {
  const running = state === 'running';
  const color = running
    ? 'text-emerald-400 border-emerald-900 bg-emerald-950/40'
    : state === 'absent'
      ? 'text-slate-500 border-border'
      : 'text-amber-400 border-amber-900 bg-amber-950/40';
  return (
    <span className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${color}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${running ? 'animate-pulse bg-emerald-400' : 'bg-current'}`} />
      {state}
    </span>
  );
}

function CtrlBtn({
  icon: Icon,
  label,
  onClick,
  busy,
  accent,
  danger,
}: {
  icon: typeof Play;
  label: string;
  onClick: () => void;
  busy?: boolean;
  accent?: boolean;
  danger?: boolean;
}) {
  const tone = accent
    ? 'bg-accent text-white hover:bg-accent/90'
    : danger
      ? 'border border-red-900 text-red-400 hover:bg-red-950'
      : 'border border-border text-slate-300 hover:bg-panel';
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs disabled:opacity-50 ${tone}`}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />} {label}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}
