import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Download,
  FileBox,
  Image as ImageIcon,
  Loader2,
  X,
} from 'lucide-react';
import { EmptyState } from '../../components/ui';
import { resourcesApi, type FlowNode } from '../../lib/api';
import type { NodeRunState } from './FlowNodeCard';
import type { RunArtifact } from './useFlowRun';

type MediaKind = 'image' | 'video' | 'audio' | 'file';

function kindOf(a: RunArtifact): MediaKind {
  if (a.mime.startsWith('image/')) return 'image';
  if (a.mime.startsWith('video/')) return 'video';
  if (a.mime.startsWith('audio/')) return 'audio';
  return a.kind === 'image' ? 'image' : 'file';
}

const KIND_ICON = { image: ImageIcon, video: Clapperboard, audio: AudioLines, file: FileBox } as const;

/**
 * The run's media, filling in as it is made.
 *
 * The run rail answers "what came out at the end"; this answers "what has been made so far", which
 * for a pipeline that renders for an hour is the question you actually have. Artifacts arrive on
 * their own event as each file is persisted (spec §5), so a shot appears the moment it exists rather
 * than when its node — or the whole run — finishes.
 *
 * Nodes still rendering appear too, as a live card carrying ComfyUI's in-progress preview frame. That
 * is deliberate: the gap between "started a video" and "have a video" is ten minutes, and an empty
 * grid for ten minutes is indistinguishable from a broken run.
 */
export function FlowMediaPanel({
  artifacts,
  states,
  nodes,
  sessionId,
}: {
  artifacts: RunArtifact[];
  states: Map<string, NodeRunState>;
  nodes: FlowNode[];
  sessionId: string;
}) {
  const [lightbox, setLightbox] = useState<number | null>(null);

  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of nodes) map.set(n.id, n.label || n.type);
    return map;
  }, [nodes]);

  // Newest first: while a run is going the thing you want is the thing that just appeared.
  const ordered = useMemo(() => [...artifacts].reverse(), [artifacts]);

  /** Nodes mid-render, so the grid shows work in flight rather than a gap. */
  const inFlight = useMemo(
    () =>
      [...states.entries()]
        .filter(([, s]) => s.status === 'running')
        .map(([id, s]) => ({ id, state: s, label: labels.get(id) ?? id }))
        .filter((n) => n.state.preview || n.state.percent != null),
    [states, labels],
  );

  useEffect(() => {
    if (lightbox === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
      if (e.key === 'ArrowRight') setLightbox((i) => (i === null ? null : Math.min(ordered.length - 1, i + 1)));
      if (e.key === 'ArrowLeft') setLightbox((i) => (i === null ? null : Math.max(0, i - 1)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, ordered.length]);

  if (ordered.length === 0 && inFlight.length === 0) {
    return (
      <div className="p-4">
        <EmptyState icon={<ImageIcon size={18} />}>Nothing produced yet.</EmptyState>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Media</span>
        <span className="text-[10px] text-slate-600">{ordered.length}</span>
        {inFlight.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-accent">
            <Loader2 size={10} className="animate-spin" />
            {inFlight.length} rendering
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {inFlight.map((n) => (
          <div key={n.id} className="overflow-hidden rounded-lg border border-accent/30 bg-accent/[0.05]">
            {n.state.preview ? (
              <img src={n.state.preview} alt="" className="max-h-40 w-full object-contain" />
            ) : (
              <div className="flex h-20 items-center justify-center">
                <Loader2 size={16} className="animate-spin text-accent/70" />
              </div>
            )}
            <div className="px-2 py-1.5">
              <div className="flex items-baseline gap-1.5">
                <span className="truncate text-[11px] text-accent">{n.label}</span>
                <span className="ml-auto shrink-0 text-[10px] text-slate-500">
                  {n.state.percent == null ? '…' : `${n.state.percent}%`}
                </span>
              </div>
              <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className={`h-full bg-accent transition-[width] duration-300 ${
                    n.state.percent == null ? 'w-1/3 animate-pulse' : ''
                  }`}
                  style={n.state.percent == null ? undefined : { width: `${Math.max(2, n.state.percent)}%` }}
                />
              </div>
              {n.state.message && (
                <div className="mt-0.5 truncate text-[9px] text-slate-500">{n.state.message}</div>
              )}
            </div>
          </div>
        ))}

        <div className="grid grid-cols-2 gap-2">
          {ordered.map((a, i) => (
            <Tile
              key={a.handle}
              artifact={a}
              sessionId={sessionId}
              label={labels.get(a.nodeId) ?? ''}
              onOpen={() => setLightbox(i)}
            />
          ))}
        </div>
      </div>

      {lightbox !== null && ordered[lightbox] && (
        <Lightbox
          artifact={ordered[lightbox]!}
          sessionId={sessionId}
          label={labels.get(ordered[lightbox]!.nodeId) ?? ''}
          index={lightbox}
          total={ordered.length}
          onClose={() => setLightbox(null)}
          onPrev={() => setLightbox((n) => Math.max(0, (n ?? 0) - 1))}
          onNext={() => setLightbox((n) => Math.min(ordered.length - 1, (n ?? 0) + 1))}
        />
      )}
    </div>
  );
}

function Tile({
  artifact,
  sessionId,
  label,
  onOpen,
}: {
  artifact: RunArtifact;
  sessionId: string;
  label: string;
  onOpen: () => void;
}) {
  const kind = kindOf(artifact);
  const Icon = KIND_ICON[kind];

  return (
    <button
      onClick={onOpen}
      className="group overflow-hidden rounded-lg border border-white/[0.06] bg-black/25 text-left transition-colors hover:border-accent/40"
    >
      <div className="relative flex h-24 items-center justify-center bg-black/30">
        {kind === 'image' && <Thumb sessionId={sessionId} handle={artifact.handle} />}
        {/* A real first frame, not a film icon — on a pipeline whose output *is* video, a grid of
            identical icons tells you nothing about what was made. `preload="metadata"` fetches only
            the header and the first frame, which the Range-capable resource route serves cheaply. */}
        {kind === 'video' && (
          <video
            src={resourcesApi.streamUrl(sessionId, artifact.handle)}
            preload="metadata"
            muted
            playsInline
            className="h-full w-full object-cover"
          />
        )}
        {(kind === 'audio' || kind === 'file') && (
          <Icon size={20} className="text-slate-600 transition-colors group-hover:text-accent/70" />
        )}
        {kind === 'video' && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-black/60 p-1.5">
              <Clapperboard size={12} className="text-white/80" />
            </span>
          </span>
        )}
        {artifact.iteration != null && (
          <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[9px] text-slate-300">
            #{artifact.iteration + 1}
          </span>
        )}
      </div>
      <div className="px-1.5 py-1">
        <div className="truncate font-mono text-[9px] text-slate-500">{artifact.handle}</div>
        {label && <div className="truncate text-[9px] text-slate-600">{label}</div>}
      </div>
    </button>
  );
}

/** Images need the auth header, so they are fetched as bytes and shown from an object URL. */
function Thumb({ sessionId, handle }: { sessionId: string; handle: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let alive = true;
    resourcesApi
      .objectUrl(sessionId, handle)
      .then((u) => {
        objectUrl = u;
        if (alive) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, handle]);

  if (!url) return <div className="h-full w-full animate-pulse bg-white/[0.04]" />;
  return <img src={url} alt={handle} className="h-full w-full object-cover" />;
}

/**
 * Full view. Fixed and full-screen rather than confined to the rail — a 1344×768 still in a 320px
 * column tells you nothing about whether the render is any good, which is the only reason to look.
 */
function Lightbox({
  artifact,
  sessionId,
  label,
  index,
  total,
  onClose,
  onPrev,
  onNext,
}: {
  artifact: RunArtifact;
  sessionId: string;
  label: string;
  index: number;
  total: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const kind = kindOf(artifact);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== 'image') return;
    let objectUrl: string | null = null;
    let alive = true;
    resourcesApi
      .objectUrl(sessionId, artifact.handle)
      .then((u) => {
        objectUrl = u;
        if (alive) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, artifact.handle, kind]);

  // Portalled to <body> deliberately: the rail is `.glass`, and a `backdrop-filter` ancestor becomes
  // the containing block for `position: fixed`, which would trap a full-screen overlay inside a
  // 320px column — the exact opposite of what a full view is for.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
    >
      <div className="flex shrink-0 items-center gap-3 px-4 py-3 text-xs text-slate-300">
        <span className="font-mono">{artifact.handle}</span>
        {label && <span className="text-slate-500">{label}</span>}
        {artifact.iteration != null && <span className="text-slate-500">shot {artifact.iteration + 1}</span>}
        <span className="text-slate-600">{formatBytes(artifact.size)}</span>
        <span className="ml-auto text-slate-600">
          {index + 1} / {total}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            void resourcesApi.download(sessionId, artifact.handle, artifact.filename);
          }}
          className="text-slate-400 transition-colors hover:text-slate-100"
          title="Download"
        >
          <Download size={15} />
        </button>
        <button onClick={onClose} className="text-slate-400 transition-colors hover:text-slate-100">
          <X size={16} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center gap-2 px-2 pb-4" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onPrev}
          disabled={index === 0}
          className="shrink-0 rounded-full p-2 text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-20"
        >
          <ChevronLeft size={22} />
        </button>

        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
          {kind === 'image' &&
            (url ? (
              <img src={url} alt={artifact.handle} className="max-h-full max-w-full object-contain" />
            ) : (
              <Loader2 className="animate-spin text-slate-500" />
            ))}
          {kind === 'video' && (
            <video
              src={resourcesApi.streamUrl(sessionId, artifact.handle)}
              controls
              autoPlay
              className="max-h-full max-w-full rounded"
            />
          )}
          {kind === 'audio' && (
            <div className="w-full max-w-lg rounded-xl bg-white/[0.04] p-6">
              <AudioLines size={28} className="mx-auto mb-4 text-slate-500" />
              <audio src={resourcesApi.streamUrl(sessionId, artifact.handle)} controls autoPlay className="w-full" />
            </div>
          )}
          {kind === 'file' && (
            <div className="text-center text-sm text-slate-500">
              <FileBox size={28} className="mx-auto mb-2" />
              {artifact.filename || artifact.handle}
            </div>
          )}
        </div>

        <button
          onClick={onNext}
          disabled={index >= total - 1}
          className="shrink-0 rounded-full p-2 text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-20"
        >
          <ChevronRight size={22} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

function formatBytes(b: number): string {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}
