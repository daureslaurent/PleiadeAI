import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  AlertTriangle,
  Boxes,
  Crosshair,
  Hammer,
  HardDrive,
  Layers,
  Monitor,
  Package,
  Plus,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  imagesApi,
  type BuildArg,
  type BuildJob,
  type Image,
  type ImageStatusDetail,
  type VisualCalibration,
} from '../lib/api';
import { MasterDetail, ListRow, ListDivider } from '../components/MasterDetail';
import {
  Button,
  Callout,
  Checkbox,
  Dot,
  EmptyState,
  Field,
  GlassCard,
  Hint,
  Input,
  RowGroup,
  Section,
  Select,
  StatusBadge,
  Toggle,
  toneOf,
  useConfirm,
} from '../components/ui';
import { MONACO_OPTIONS, PLEIADES_THEME, registerPleiadesTheme } from '../lib/monacoTheme';

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
  /** Visual desktop resolution; null → boot default (1280×800). */
  visual_width: number | null;
  visual_height: number | null;
}

/**
 * Visual layer appended to the Dockerfile when the "Visual desktop" toggle is on. Mirrors the
 * backend source of truth `VISUAL_DOCKERFILE_SNIPPET` (isolation/visual.template.ts) — kept in sync
 * by hand since the frontend can't import backend modules. Provisions Xvfb + x11vnc + the input
 * tooling the visual_screenshot / visual_act tools drive. Injected up front so the operator can
 * still edit it freely before building.
 */
const VISUAL_MARKER = '# --- PleiadesAI visual layer';
const VISUAL_SNIPPET = `# --- PleiadesAI visual layer (Xvfb desktop + loopback VNC, driven by the visual_* tools) ---
RUN apt-get update && apt-get install -y --no-install-recommends \\
      xvfb x11vnc fluxbox xdotool scrot socat procps \\
      x11-utils x11-xserver-utils fonts-dejavu-core \\
      tesseract-ocr \\
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
  visual_width: null,
  visual_height: null,
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
  visual_width: i.visual_width ?? null,
  visual_height: i.visual_height ?? null,
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
  const confirm = useConfirm();
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
        visual_width: draft.visual_width,
        visual_height: draft.visual_height,
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
    const ok = await confirm({
      title: `Delete image “${draft.name}”?`,
      body: 'This removes its built docker layers. This cannot be undone.',
      danger: true,
    });
    if (!ok) return;
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
            <Layers size={15} className="shrink-0" />
            <span className="flex-1 truncate">Builds</span>
            {activeBuilds > 0 && (
              <span className="shrink-0 rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-400">
                {activeBuilds} active
              </span>
            )}
          </ListRow>
          <ListDivider />
          {items.map((i) => {
            const s = i.build_job?.status === 'running' ? 'building' : i.image_status;
            return (
              <ListRow key={i._id} active={!showBuilds && draft?._id === i._id} onClick={() => select(i)}>
                <Package size={15} className="shrink-0" />
                <span className="flex-1 truncate">{i.name}</span>
                <Dot tone={toneOf(s)} title={`image: ${s}`} pulse={s === 'building'} />
              </ListRow>
            );
          })}
        </>
      }
    >
      {showBuilds ? (
        <BuildsPanel builds={builds} items={items} onRefresh={loadBuilds} onSelect={select} />
      ) : !draft ? (
        <EmptyState icon={<Package size={28} />}>Select an image or create a new one.</EmptyState>
      ) : (
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {/* Action row — the only place the loud accent lives on this page. */}
          <div className="flex items-center gap-2">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="image_name (e.g. python-dev)"
              className="flex-1 font-mono"
            />
            {!isNew && (
              <Button variant="danger" icon={<Trash2 size={13} />} onClick={remove}>
                Delete
              </Button>
            )}
            <Button variant="primary" icon={<Save size={13} />} onClick={save} loading={saving}>
              Save
            </Button>
          </div>

          <Section
            title="Image"
            icon={<Package size={13} />}
            right={status && <StatusBadge tone={toneOf(status.image_status)}>image: {status.image_status}</StatusBadge>}
          >
            <div className="space-y-3">
              <Field label="Description">
                <Input
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="What this image provides"
                />
              </Field>
              {status && status.warnings.length > 0 && (
                <Callout tone="warn" icon={<AlertTriangle size={13} />}>
                  <div className="flex flex-col gap-1">
                    {status.warnings.map((w) => (
                      <span key={w}>{w}</span>
                    ))}
                  </div>
                </Callout>
              )}
            </div>
          </Section>

          <Section title="Visual desktop" icon={<Monitor size={13} />}>
            <div className="space-y-4">
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

              {draft.visual && (
                <ResolutionSelect
                  width={draft.visual_width}
                  height={draft.visual_height}
                  onChange={(w, h) => setDraft({ ...draft, visual_width: w, visual_height: h })}
                />
              )}

              {draft.visual && !isNew && (
                <CalibrationRow
                  imageId={draft._id!}
                  calibration={items.find((i) => i._id === draft._id)?.visual_calibration ?? null}
                  onCleared={refresh}
                />
              )}
            </div>
          </Section>

          <Section title="Dockerfile" icon={<Layers size={13} />}>
            <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-black/25 py-1">
              <Editor
                height="300px"
                defaultLanguage="dockerfile"
                theme={PLEIADES_THEME}
                beforeMount={registerPleiadesTheme}
                value={draft.dockerfile}
                onChange={(v) => setDraft({ ...draft, dockerfile: v ?? '' })}
                options={MONACO_OPTIONS}
              />
            </div>
          </Section>

          <Section title="Build options" icon={<Boxes size={13} />}>
            <BuildOptions draft={draft} setDraft={setDraft} />
          </Section>

          <Section title="Build" icon={<Hammer size={13} />}>
            {isNew ? (
              <Hint>Save the image before building it.</Hint>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="accentSoft"
                    icon={<Hammer size={13} />}
                    onClick={build}
                    disabled={building}
                  >
                    {building ? 'Building…' : 'Build image'}
                  </Button>
                  {status && (
                    <>
                      <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
                        <Users size={12} /> used by {status.referenced_by.length} profile(s)
                      </span>
                      {status.image_size != null && (
                        <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
                          <HardDrive size={12} /> {fmtBytes(status.image_size)}
                        </span>
                      )}
                      {status.image_built_at && (
                        <span className="text-[11px] text-slate-500">
                          built {new Date(status.image_built_at).toLocaleString()}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <Hint>
                  Builds run in the background, one at a time. You can leave this page — the log
                  reattaches when you return. On success, containers of agents whose profile uses this
                  image are recreated on their next run.
                </Hint>
                {status?.last_build_error && !building && (
                  <Callout tone="error" icon={<AlertTriangle size={13} />}>
                    {status.last_build_error}
                  </Callout>
                )}
              </div>
            )}
          </Section>

          {/* Build console — the bash-terminal exception (DIRECT_ART §7): near-black terminal glass. */}
          <Section title="Build console" icon={<Terminal size={13} />}>
            <pre
              ref={logRef}
              className="h-72 overflow-auto rounded-xl border border-white/[0.06] bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-slate-300"
            >
              {logs || (
                <span className="text-slate-600">No build output yet. Click “Build image”.</span>
              )}
            </pre>
          </Section>
        </div>
      )}
    </MasterDetail>
  );
}

function isBuildingStatus(status: ImageStatusDetail | null): boolean {
  return status?.image_status === 'building' || status?.image_status === 'queued';
}

/** Common visual desktop resolutions offered in the selector (Xvfb screen size, 24-bit depth). */
const RESOLUTION_PRESETS: Array<[number, number]> = [
  [700, 700],
  [800, 800],
  [900, 900],
  [1000, 1000],
  [1024, 768],
  [1280, 800],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [1920, 1080],
];

/**
 * Visual desktop resolution selector. `null` width/height = the boot default (1280×800). A change
 * applies on the next desktop start (the running desktop must restart), and drops any calibration.
 */
function ResolutionSelect({
  width,
  height,
  onChange,
}: {
  width: number | null;
  height: number | null;
  onChange: (w: number | null, h: number | null) => void;
}) {
  const current = width && height ? `${width}x${height}` : 'default';
  // Show a custom (API-set) resolution that isn't among the presets so it round-trips.
  const custom =
    width && height && !RESOLUTION_PRESETS.some(([w, h]) => w === width && h === height)
      ? ([width, height] as [number, number])
      : null;
  return (
    <Field
      label="Desktop resolution"
      hint="The Xvfb/VNC screen size. Applies on the next desktop start — stop the agent’s container to apply now. Changing it clears any click calibration. No rebuild needed."
    >
      <Select
        value={current}
        onChange={(e) => {
          if (e.target.value === 'default') return onChange(null, null);
          const [w, h] = e.target.value.split('x').map(Number);
          onChange(w!, h!);
        }}
        className="w-fit py-1.5 text-xs"
      >
        <option value="default">Default (1280×800)</option>
        {custom && (
          <option value={`${custom[0]}x${custom[1]}`}>
            {custom[0]}×{custom[1]} (custom)
          </option>
        )}
        {RESOLUTION_PRESETS.map(([w, h]) => (
          <option key={`${w}x${h}`} value={`${w}x${h}`}>
            {w}×{h}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * Click-calibration status for a visual image. Calibration itself is *run* from an agent's live
 * desktop (VisualPanel → Calibrate), where a booted desktop exists; here we only display the stored
 * result and offer a manual Clear. Auto-cleared on rebuild by the backend.
 */
function CalibrationRow({
  imageId,
  calibration,
  onCleared,
}: {
  imageId: string;
  calibration: VisualCalibration | null;
  onCleared: () => Promise<unknown> | void;
}) {
  const [clearing, setClearing] = useState(false);
  const clear = async () => {
    setClearing(true);
    try {
      await imagesApi.clearCalibration(imageId);
      await onCleared();
    } finally {
      setClearing(false);
    }
  };
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-black/25 p-3 text-xs">
      <Crosshair size={14} className="mt-0.5 shrink-0 text-accent" />
      {calibration ? (
        <div className="min-w-0 flex-1">
          <div className="text-slate-300">
            Click calibration active — mean error{' '}
            <span className="text-slate-400">{calibration.error_before.toFixed(1)}px</span> →{' '}
            <span className="text-emerald-400">{calibration.error_after.toFixed(1)}px</span> over{' '}
            {calibration.samples} points.
          </div>
          <div className="mt-1 font-mono text-[10px] text-slate-500">
            {calibration.width}×{calibration.height} · {calibration.vision_model} ·{' '}
            {new Date(calibration.measured_at).toLocaleString()}
          </div>
        </div>
      ) : (
        <div className="min-w-0 flex-1 text-slate-400">
          No click calibration. Open an agent’s desktop (this image) and click <b>Calibrate</b> to
          correct where clicks land.
        </div>
      )}
      {calibration && (
        <Button variant="ghost" onClick={clear} loading={clearing} className="px-2 py-1">
          Clear
        </Button>
      )}
    </div>
  );
}

/**
 * "Visual desktop" toggle. Turning it on injects the visual layer into the Dockerfile up front (the
 * operator keeps full control to edit it after) and flags the image so agents on a profile using it
 * are auto-granted the visual_screenshot / visual_act tools. Turning it off strips the layer again.
 */
function VisualToggle({ visual, onToggle }: { visual: boolean; onToggle: (on: boolean) => void }) {
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${
        visual ? 'border-accent/40 bg-accent/[0.07]' : 'border-white/[0.06] bg-black/25'
      }`}
    >
      <Monitor size={16} className={`mt-0.5 shrink-0 ${visual ? 'text-accent' : 'text-slate-500'}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-200">Visual desktop</div>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          Adds a headless X desktop (Xvfb + VNC) so agents can see and drive a GUI. Injects the visual
          layer into the Dockerfile below (editable) and auto-grants{' '}
          <span className="font-mono text-slate-400">visual_screenshot</span> /{' '}
          <span className="font-mono text-slate-400">visual_act</span> to agents using this image.
        </p>
      </div>
      <Toggle checked={visual} onChange={onToggle} />
    </div>
  );
}

/** Build args (key/value) + `--no-cache` / `--pull` toggles. */
function BuildOptions({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const setArg = (idx: number, patch: Partial<BuildArg>) =>
    setDraft({
      ...draft,
      build_args: draft.build_args.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">
          Build args (--build-arg)
        </div>
        {draft.build_args.map((a, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={a.key}
              onChange={(e) => setArg(i, { key: e.target.value })}
              placeholder="KEY"
              className="w-40 py-1.5 font-mono text-[11px]"
            />
            <span className="text-slate-600">=</span>
            <Input
              value={a.value}
              onChange={(e) => setArg(i, { value: e.target.value })}
              placeholder="value"
              className="flex-1 py-1.5 font-mono text-[11px]"
            />
            <button
              onClick={() =>
                setDraft({ ...draft, build_args: draft.build_args.filter((_, j) => j !== i) })
              }
              className="shrink-0 rounded-md p-1.5 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
              title="Remove"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            setDraft({ ...draft, build_args: [...draft.build_args, { key: '', value: '' }] })
          }
          className="flex items-center gap-1 rounded-lg border border-dashed border-white/[0.12] px-2.5 py-1.5 text-[11px] text-slate-400 transition-colors hover:border-accent/50 hover:text-accent"
        >
          <Plus size={12} /> Add build arg
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-5">
        <Checkbox checked={draft.no_cache} onChange={(v) => setDraft({ ...draft, no_cache: v })}>
          <span className="font-mono">--no-cache</span>
          <span className="text-slate-500">(ignore layer cache)</span>
        </Checkbox>
        <Checkbox checked={draft.pull} onChange={(v) => setDraft({ ...draft, pull: v })}>
          <span className="font-mono">--pull</span>
          <span className="text-slate-500">(always re-fetch base image)</span>
        </Checkbox>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-400">Build timeout</span>
        <Input
          type="number"
          min={1}
          value={draft.build_timeout_min}
          onChange={(e) => setDraft({ ...draft, build_timeout_min: e.target.value })}
          placeholder="default"
          className="w-24 py-1.5"
        />
        <span className="text-[11px] text-slate-500">
          minutes — leave blank for the server default. Raise it for slow builds.
        </span>
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
      <Section
        title="Builds"
        icon={<Layers size={13} />}
        right={
          <>
            <span className="text-[11px] text-slate-500">{rows.length} known this session</span>
            <Button variant="ghost" icon={<RefreshCw size={13} />} onClick={onRefresh}>
              Refresh
            </Button>
          </>
        }
      >
        <Hint>
          Every image build queued or run since the backend last started. Builds are serialised (one
          at a time). Select a row to open its image and reattach to the build console.
        </Hint>
      </Section>

      {sorted.length === 0 ? (
        <GlassCard>
          <EmptyState icon={<Layers size={28} />}>No builds yet.</EmptyState>
        </GlassCard>
      ) : (
        <RowGroup>
          {sorted.map((b) => {
            const img = byId.get(b.image_id);
            return (
              <div key={b.image_id + b.queued_at} className="flex items-center gap-3 px-3 py-2.5 text-xs">
                <StatusBadge tone={toneOf(b.status)}>{b.status}</StatusBadge>
                <button
                  onClick={() => img && onSelect(img)}
                  disabled={!img}
                  className="min-w-0 flex-1 text-left disabled:cursor-default"
                >
                  <div className="truncate text-slate-200 transition-colors hover:text-accent">
                    {img?.name ?? <span className="text-slate-500">{b.image_id} (deleted)</span>}
                  </div>
                  {b.error && <div className="truncate text-[10px] text-red-400">{b.error}</div>}
                </button>
                <span className="shrink-0 font-mono text-[10px] text-slate-600">
                  {fmtWhen(b.ended_at ?? b.started_at ?? b.queued_at)}
                </span>
              </div>
            );
          })}
        </RowGroup>
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
