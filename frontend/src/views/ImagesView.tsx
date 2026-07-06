import { useEffect, useRef, useState, type ReactNode } from 'react';
import Editor from '@monaco-editor/react';
import {
  AlertTriangle,
  Boxes,
  Hammer,
  Layers,
  Monitor,
  Package,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  imagesApi,
  type BuildArg,
  type BuildJob,
  type Image,
  type ImageStatus,
  type ImageStatusDetail,
} from '../lib/api';
import { MasterDetail, ListRow } from '../components/MasterDetail';

interface Draft {
  _id?: string;
  name: string;
  description: string;
  dockerfile: string;
  build_args: BuildArg[];
  no_cache: boolean;
  pull: boolean;
  /** Build timeout in minutes; empty string = use the server default. */
  build_timeout_min: string;
  /** Visual-desktop image: Dockerfile carries the visual layer; agents get the visual_* tools. */
  visual: boolean;
}

/**
 * Visual layer appended to the Dockerfile when the "Visual desktop" toggle is on. Mirrors the
 * backend source of truth `VISUAL_DOCKERFILE_SNIPPET` (isolation/visual.template.ts) — kept in sync
 * by hand since the frontend can't import backend modules. Provisions Xvfb + x11vnc + the input
 * tooling the visual_screenshot / visual_act tools drive. Injected up front so the operator can
 * still edit it freely before building.
 */
const VISUAL_MARKER = '# --- PleiadeAI visual layer';
const VISUAL_SNIPPET = `# --- PleiadeAI visual layer (Xvfb desktop + loopback VNC, driven by the visual_* tools) ---
RUN apt-get update && apt-get install -y --no-install-recommends \\
      xvfb x11vnc fluxbox xdotool scrot socat procps \\
      x11-utils x11-xserver-utils fonts-dejavu-core \\
      python3-tk python3-pip \\
    && pip3 install --no-cache-dir --break-system-packages pyautogui pillow \\
    && rm -rf /var/lib/apt/lists/*`;

/** Append the visual layer once (no-op if already present). */
function withVisualLayer(dockerfile: string): string {
  if (dockerfile.includes(VISUAL_MARKER)) return dockerfile;
  return `${dockerfile.replace(/\s*$/, '')}\n\n${VISUAL_SNIPPET}\n`;
}

/** Strip the appended visual layer (everything from its marker to the end — we always append last). */
function withoutVisualLayer(dockerfile: string): string {
  const idx = dockerfile.indexOf(VISUAL_MARKER);
  return idx === -1 ? dockerfile : `${dockerfile.slice(0, idx).replace(/\s*$/, '')}\n`;
}

const DEFAULT_DOCKERFILE = `# Docker image for isolated agent runtimes.
# Requirements: bash, python3, and node must remain available for the terminal tool and skills.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    bash python3 python3-pip git curl ca-certificates build-essential \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# --- Add your customisations here (apt/pip/npm installs, tools, env, etc.) ---
`;

const blank = (): Draft => ({
  name: '',
  description: '',
  dockerfile: DEFAULT_DOCKERFILE,
  build_args: [],
  no_cache: false,
  pull: false,
  build_timeout_min: '',
  visual: false,
});

const toDraft = (i: Image): Draft => ({
  _id: i._id,
  name: i.name,
  description: i.description,
  dockerfile: i.dockerfile,
  build_args: i.build_args ?? [],
  no_cache: i.no_cache,
  pull: i.pull,
  build_timeout_min: i.build_timeout_ms ? String(Math.round(i.build_timeout_ms / 60000)) : '',
  visual: Boolean(i.visual),
});

/**
 * Images page (master-detail): create/edit/delete standalone Docker images. Each image owns a
 * Dockerfile + build options and builds in the background (serialised queue). The build console
 * streams docker output live and *reattaches* if you leave and return mid-build. Isolation profiles
 * (Isolation page) reference an image; agents pick a profile.
 */
export function ImagesView() {
  const [items, setItems] = useState<Image[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<ImageStatusDetail | null>(null);
  const [logs, setLogs] = useState('');
  const [saving, setSaving] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  // The image whose build stream we're currently attached to — guards stale async log callbacks
  // from a previous selection writing into the newly-selected image's console.
  const streamIdRef = useRef<string | null>(null);

  // Global builds overview (all images): shown in the detail pane instead of an editor.
  const [builds, setBuilds] = useState<BuildJob[] | null>(null);
  const [showBuilds, setShowBuilds] = useState(false);

  const isNew = draft && !draft._id;
  const activeBuilds = (items ?? []).filter(
    (i) => i.build_job?.status === 'queued' || i.build_job?.status === 'running',
  ).length;

  async function refresh() {
    const list = await imagesApi.list();
    setItems(list);
    return list;
  }
  async function loadBuilds() {
    setBuilds(await imagesApi.builds().catch(() => []));
  }
  useEffect(() => {
    void refresh();
  }, []);

  // Poll the list while any build is active so status dots + the builds overview stay live.
  useEffect(() => {
    if (activeBuilds === 0 && !showBuilds) return;
    const t = setInterval(() => {
      void refresh();
      if (showBuilds) void loadBuilds();
    }, 2000);
    return () => clearInterval(t);
  }, [activeBuilds, showBuilds]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [logs]);

  async function loadStatus(id: string) {
    setStatus(await imagesApi.status(id).catch(() => null));
  }

  /** Attach to an image's build-log stream (reattach); only writes while it stays selected. */
  async function attach(id: string) {
    await imagesApi.streamLogs(id, {
      onLog: (c) => streamIdRef.current === id && setLogs((l) => l + c),
      onDone: (size) =>
        streamIdRef.current === id &&
        setLogs((l) => `${l}\n✓ build succeeded${size ? ` — ${fmtBytes(size)}` : ''}\n`),
      onError: (m) => streamIdRef.current === id && setLogs((l) => `${l}\n✗ ${m}\n`),
    });
    // Terminal state reached (or stream closed): refresh status/list so the badge settles.
    if (streamIdRef.current === id) {
      await refresh();
      await loadStatus(id);
    }
  }

  function select(i: Image) {
    setShowBuilds(false);
    streamIdRef.current = i._id;
    setDraft(toDraft(i));
    setLogs('');
    setStatus(null);
    void loadStatus(i._id);
    // Reattach: replays the buffered log of an in-flight / just-finished build (empty otherwise).
    void attach(i._id);
  }

  function newImage() {
    setShowBuilds(false);
    streamIdRef.current = null;
    setDraft(blank());
    setLogs('');
    setStatus(null);
  }

  function openBuilds() {
    setShowBuilds(true);
    setDraft(null);
    streamIdRef.current = null;
    void loadBuilds();
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        dockerfile: draft.dockerfile,
        build_args: draft.build_args.filter((a) => a.key.trim()),
        no_cache: draft.no_cache,
        pull: draft.pull,
        visual: draft.visual,
        // Minutes → ms; blank/invalid clears the override (server default applies).
        build_timeout_ms: draft.build_timeout_min.trim()
          ? Math.max(1, Number(draft.build_timeout_min) || 0) * 60000
          : null,
      };
      if (isNew) {
        const created = await imagesApi.create(body);
        await refresh();
        select(created);
      } else {
        await imagesApi.update(draft._id!, body);
        await refresh();
        await loadStatus(draft._id!);
      }
    } catch (e) {
      alert(`Save failed: ${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function build() {
    if (!draft?._id) return;
    // Persist any pending edits first so the build uses the on-screen Dockerfile + options.
    await save();
    setLogs('');
    streamIdRef.current = draft._id;
    try {
      await imagesApi.enqueueBuild(draft._id);
      await refresh();
      await attach(draft._id);
    } catch (e) {
      setLogs((l) => `${l}\n✗ ${errMsg(e)}\n`);
    }
  }

  async function remove() {
    if (!draft?._id) return;
    const refs = status?.referenced_by ?? [];
    if (refs.length > 0) {
      alert(
        `This image is used by ${refs.length} isolation profile(s): ${refs
          .map((r) => r.name)
          .join(', ')}.\n\nUnassign it from those profiles on the Isolation page before deleting.`,
      );
      return;
    }
    if (!confirm('Delete this image (removes its built docker layers)? This cannot be undone.')) return;
    try {
      await imagesApi.remove(draft._id);
      setDraft(null);
      setStatus(null);
      streamIdRef.current = null;
      await refresh();
    } catch (e) {
      alert(`Delete failed: ${errMsg(e)}`);
    }
  }

  const building = Boolean(status?.build_active) || isBuildingStatus(status);

  return (
    <MasterDetail
      newLabel="New image"
      onNew={newImage}
      list={
        <>
          <ListRow active={showBuilds} onClick={openBuilds}>
            <Layers size={15} /> Builds
            {activeBuilds > 0 && (
              <span className="ml-auto rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-400">
                {activeBuilds} active
              </span>
            )}
          </ListRow>
          <div className="my-1 border-t border-border" />
          {items.map((i) => (
            <ListRow key={i._id} active={!showBuilds && draft?._id === i._id} onClick={() => select(i)}>
              <Package size={15} /> {i.name}
              <ImageDot status={i.build_job?.status === 'running' ? 'building' : i.image_status} />
            </ListRow>
          ))}
        </>
      }
    >
      {showBuilds ? (
        <BuildsPanel builds={builds} items={items} onRefresh={loadBuilds} onSelect={select} />
      ) : !draft ? (
        <Empty />
      ) : (
        <div className="mx-auto max-w-3xl space-y-5 p-6">
          <div className="flex items-center gap-3">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="image_name (e.g. python-dev)"
              className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
            />
            {!isNew && (
              <button
                onClick={remove}
                className="flex items-center gap-1 rounded-md border border-red-900 px-3 py-2 text-xs text-red-400 hover:bg-red-950"
              >
                <Trash2 size={14} /> Delete
              </button>
            )}
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              <Save size={15} /> Save
            </button>
          </div>

          <Label>Description</Label>
          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="What this image provides"
            className="w-full rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
          />

          {status && status.warnings.length > 0 && (
            <div className="flex flex-col gap-1 rounded border border-amber-900 bg-amber-950/40 p-2 text-xs text-amber-300">
              {status.warnings.map((w) => (
                <span key={w} className="flex items-start gap-1.5">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {w}
                </span>
              ))}
            </div>
          )}

          <VisualToggle
            visual={draft.visual}
            onToggle={(on) =>
              setDraft({
                ...draft,
                visual: on,
                dockerfile: on
                  ? withVisualLayer(draft.dockerfile)
                  : withoutVisualLayer(draft.dockerfile),
              })
            }
          />

          <div className="flex items-center justify-between">
            <Label>Dockerfile</Label>
            {status && <StatusBadge status={status.image_status} />}
          </div>
          <div className="overflow-hidden rounded border border-border">
            <Editor
              height="300px"
              defaultLanguage="dockerfile"
              theme="vs-dark"
              value={draft.dockerfile}
              onChange={(v) => setDraft({ ...draft, dockerfile: v ?? '' })}
              options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }}
            />
          </div>

          <BuildOptions draft={draft} setDraft={setDraft} />

          {isNew ? (
            <p className="text-xs text-slate-500">Save the image before building it.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={build}
                  disabled={building}
                  className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  <Hammer size={13} /> {building ? 'Building…' : 'Build image'}
                </button>
                {status && (
                  <>
                    <span className="flex items-center gap-1 text-xs text-slate-500">
                      <Users size={13} /> used by {status.referenced_by.length} profile(s)
                    </span>
                    {status.image_size != null && (
                      <span className="text-xs text-slate-500">size {fmtBytes(status.image_size)}</span>
                    )}
                    {status.image_built_at && (
                      <span className="text-xs text-slate-500">
                        built {new Date(status.image_built_at).toLocaleString()}
                      </span>
                    )}
                  </>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                Builds run in the background, one at a time. You can leave this page — the log
                reattaches when you return. On success, containers of agents whose profile uses this
                image are recreated on their next run.
              </p>
              {status?.last_build_error && !building && (
                <div className="flex items-start gap-1.5 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {status.last_build_error}
                </div>
              )}
            </>
          )}

          {/* Build console */}
          <div className="space-y-1.5">
            <Label>Build console</Label>
            <pre
              ref={logRef}
              className="h-72 overflow-auto rounded border border-border bg-black/70 p-3 font-mono text-[11px] leading-relaxed text-slate-300"
            >
              {logs || <span className="text-slate-600">No build output yet. Click “Build image”.</span>}
            </pre>
          </div>
        </div>
      )}
    </MasterDetail>
  );
}

function isBuildingStatus(status: ImageStatusDetail | null): boolean {
  return status?.image_status === 'building' || status?.image_status === 'queued';
}

/**
 * "Visual desktop" toggle. Turning it on injects the visual layer into the Dockerfile up front (the
 * operator keeps full control to edit it after) and flags the image so agents on a profile using it
 * are auto-granted the visual_screenshot / visual_act tools. Turning it off strips the layer again.
 */
function VisualToggle({ visual, onToggle }: { visual: boolean; onToggle: (on: boolean) => void }) {
  return (
    <div
      className={`flex items-start gap-3 rounded-md border p-3 ${
        visual ? 'border-accent/60 bg-accent/5' : 'border-border bg-surface/40'
      }`}
    >
      <Monitor size={16} className={`mt-0.5 shrink-0 ${visual ? 'text-accent' : 'text-slate-500'}`} />
      <div className="min-w-0 flex-1">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-200">
          <input
            type="checkbox"
            checked={visual}
            onChange={(e) => onToggle(e.target.checked)}
            className="accent-accent"
          />
          Visual desktop
        </label>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          Adds a headless X desktop (Xvfb + VNC) so agents can see and drive a GUI. Injects the visual
          layer into the Dockerfile below (editable) and auto-grants{' '}
          <span className="font-mono text-slate-400">visual_screenshot</span> /{' '}
          <span className="font-mono text-slate-400">visual_act</span> to agents using this image.
        </p>
      </div>
    </div>
  );
}

/** Build args (key/value) + `--no-cache` / `--pull` toggles. */
function BuildOptions({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
}) {
  const setArg = (idx: number, patch: Partial<BuildArg>) =>
    setDraft({
      ...draft,
      build_args: draft.build_args.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    });

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface/40 p-3">
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
        <Boxes size={13} /> Build options
      </span>

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">Build args (--build-arg)</div>
        {draft.build_args.map((a, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={a.key}
              onChange={(e) => setArg(i, { key: e.target.value })}
              placeholder="KEY"
              className="w-40 rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
            />
            <span className="text-slate-600">=</span>
            <input
              value={a.value}
              onChange={(e) => setArg(i, { value: e.target.value })}
              placeholder="value"
              className="flex-1 rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
            />
            <button
              onClick={() => setDraft({ ...draft, build_args: draft.build_args.filter((_, j) => j !== i) })}
              className="rounded border border-border p-1 text-slate-500 hover:border-red-900 hover:text-red-400"
              title="Remove"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button
          onClick={() => setDraft({ ...draft, build_args: [...draft.build_args, { key: '', value: '' }] })}
          className="flex items-center gap-1 rounded border border-dashed border-border px-2 py-1 text-[11px] text-slate-400 hover:border-accent hover:text-accent"
        >
          <Plus size={12} /> Add build arg
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-5 text-xs text-slate-300">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={draft.no_cache}
            onChange={(e) => setDraft({ ...draft, no_cache: e.target.checked })}
            className="accent-accent"
          />
          <span className="font-mono">--no-cache</span>
          <span className="text-slate-500">(ignore layer cache)</span>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={draft.pull}
            onChange={(e) => setDraft({ ...draft, pull: e.target.checked })}
            className="accent-accent"
          />
          <span className="font-mono">--pull</span>
          <span className="text-slate-500">(always re-fetch base image)</span>
        </label>
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-300">
        <span className="text-slate-400">Build timeout</span>
        <input
          type="number"
          min={1}
          value={draft.build_timeout_min}
          onChange={(e) => setDraft({ ...draft, build_timeout_min: e.target.value })}
          placeholder="default"
          className="w-24 rounded border border-border bg-surface px-2 py-1 outline-none focus:border-accent"
        />
        <span className="text-slate-500">minutes — leave blank for the server default. Raise it for slow builds.</span>
      </div>
    </div>
  );
}

/** Global overview of every build job this backend process knows about. */
function BuildsPanel({
  builds,
  items,
  onRefresh,
  onSelect,
}: {
  builds: BuildJob[] | null;
  items: Image[];
  onRefresh: () => void;
  onSelect: (i: Image) => void;
}) {
  const rows = builds ?? [];
  const byId = new Map(items.map((i) => [i._id, i]));
  // Most recent first.
  const sorted = [...rows].sort((a, b) => (b.started_at ?? b.queued_at) - (a.started_at ?? a.queued_at));

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Layers size={16} /> Builds
        </h2>
        <span className="text-xs text-slate-500">{rows.length} known this session</span>
        <button
          onClick={onRefresh}
          className="ml-auto flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-slate-300 hover:border-accent"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      <p className="text-[11px] text-slate-500">
        Every image build queued or run since the backend last started. Builds are serialised (one at
        a time). Select a row to open its image and reattach to the build console.
      </p>

      {sorted.length === 0 ? (
        <p className="text-xs text-slate-600">No builds yet.</p>
      ) : (
        <div className="divide-y divide-border rounded border border-border">
          {sorted.map((b) => {
            const img = byId.get(b.image_id);
            return (
              <div key={b.image_id + b.queued_at} className="flex items-center gap-3 px-3 py-2 text-xs">
                <BuildStateBadge status={b.status} />
                <button
                  onClick={() => img && onSelect(img)}
                  disabled={!img}
                  className="min-w-0 text-left disabled:cursor-default"
                >
                  <div className="truncate text-slate-200 hover:text-accent">
                    {img?.name ?? <span className="text-slate-500">{b.image_id} (deleted)</span>}
                  </div>
                  {b.error && <div className="truncate text-[10px] text-red-400">{b.error}</div>}
                </button>
                <span className="ml-auto shrink-0 text-[10px] text-slate-500">
                  {fmtWhen(b.ended_at ?? b.started_at ?? b.queued_at)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Human byte size (docker image sizes are large, so MB/GB granularity is plenty). */
function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

function errMsg(e: unknown): string {
  if (e && typeof e === 'object' && 'response' in e) {
    const r = (e as { response?: { data?: { error?: string } } }).response;
    if (r?.data?.error) return r.data.error;
  }
  return e instanceof Error ? e.message : String(e);
}

function StatusBadge({ status }: { status: ImageStatus }) {
  const color =
    status === 'built'
      ? 'text-emerald-400 border-emerald-900'
      : status === 'building' || status === 'queued'
        ? 'text-amber-400 border-amber-900'
        : status === 'error'
          ? 'text-red-400 border-red-900'
          : 'text-slate-500 border-border';
  return (
    <span className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ${color}`}>
      image: {status}
    </span>
  );
}

function BuildStateBadge({ status }: { status: BuildJob['status'] }) {
  const map: Record<BuildJob['status'], string> = {
    running: 'text-amber-400 border-amber-900 bg-amber-950/40',
    queued: 'text-slate-400 border-slate-700 bg-surface',
    done: 'text-emerald-400 border-emerald-900 bg-emerald-950/40',
    error: 'text-red-400 border-red-900 bg-red-950/40',
  };
  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${map[status]}`}>
      {status}
    </span>
  );
}

function ImageDot({ status }: { status: ImageStatus }) {
  const color =
    status === 'built'
      ? 'bg-emerald-400'
      : status === 'building' || status === 'queued'
        ? 'bg-amber-400'
        : status === 'error'
          ? 'bg-red-400'
          : 'bg-slate-600';
  return <span className={`ml-auto h-1.5 w-1.5 rounded-full ${color}`} title={`image: ${status}`} />;
}

function Label({ children }: { children: ReactNode }) {
  return <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{children}</div>;
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-slate-600">
      Select an image or create a new one.
    </div>
  );
}
