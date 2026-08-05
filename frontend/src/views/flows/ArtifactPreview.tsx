import { useEffect, useState } from 'react';
import { AudioLines, Clapperboard, Download, FileBox, Play } from 'lucide-react';
import { resourcesApi } from '../../lib/api';

/**
 * A flow artifact, previewed in place.
 *
 * Everything a run produces is an ordinary session resource under the run's id (FLOWS_PLAN.md §1.1),
 * so this reads through the same content route the workspace Data tab uses — including its Range
 * support, which is what lets a generated video scrub instead of re-downloading on every seek.
 *
 * Video and audio elements mount only once asked for: a grid of `<video>` tags each preloading
 * metadata would fire a request per artifact the moment a finished run is opened.
 */
export function ArtifactPreview({
  sessionId,
  handle,
  mime,
  filename,
}: {
  sessionId: string;
  handle: string;
  mime?: string;
  filename?: string;
}) {
  const kind = kindOf(mime, handle);
  const [playing, setPlaying] = useState(false);

  if (kind === 'image') {
    return (
      <figure className="overflow-hidden rounded-lg border border-white/[0.06] bg-black/25">
        <ImageBytes sessionId={sessionId} handle={handle} />
        <figcaption className="flex items-center gap-1 px-2 py-1 font-mono text-[9px] text-slate-600">
          {handle}
          <button
            onClick={() => resourcesApi.download(sessionId, handle, filename)}
            className="ml-auto transition-colors hover:text-slate-300"
            title="Download"
          >
            <Download size={11} />
          </button>
        </figcaption>
      </figure>
    );
  }

  const Icon = kind === 'video' ? Clapperboard : kind === 'audio' ? AudioLines : FileBox;

  return (
    <div className="rounded-lg border border-white/[0.06] bg-black/25 p-2">
      <div className="flex items-center gap-1.5">
        <Icon size={13} className="shrink-0 text-slate-500" />
        <span className="truncate font-mono text-[10px] text-slate-400">{filename || handle}</span>
        {(kind === 'video' || kind === 'audio') && !playing && (
          <button
            onClick={() => setPlaying(true)}
            className="ml-auto shrink-0 text-slate-500 transition-colors hover:text-accent"
            title="Play"
          >
            <Play size={12} />
          </button>
        )}
        <button
          onClick={() => resourcesApi.download(sessionId, handle, filename)}
          className={`shrink-0 text-slate-500 transition-colors hover:text-slate-200 ${playing ? 'ml-auto' : ''}`}
          title="Download"
        >
          <Download size={11} />
        </button>
      </div>

      {playing && kind === 'video' && (
        <video src={resourcesApi.streamUrl(sessionId, handle)} controls autoPlay className="mt-2 w-full rounded" />
      )}
      {playing && kind === 'audio' && (
        <audio src={resourcesApi.streamUrl(sessionId, handle)} controls autoPlay className="mt-2 w-full" />
      )}
    </div>
  );
}

/** Images are fetched as bytes (they need the auth header) and shown from an object URL. */
function ImageBytes({ sessionId, handle }: { sessionId: string; handle: string }) {
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

  if (!url) return <div className="h-24 animate-pulse bg-white/[0.04]" />;
  return <img src={url} alt={handle} className="max-h-48 w-full object-contain" />;
}

/**
 * Display kind follows the media type, not the storage kind: generated video and audio are both
 * stored as blobs, so branching on `kind` would file a playable clip under "download me".
 *
 * When only a handle is known (an edge carries handles, not metadata) the prefix decides: `img_` is
 * always an image, and anything else is treated as an opaque file until its mime says otherwise.
 */
function kindOf(mime: string | undefined, handle: string): 'image' | 'video' | 'audio' | 'file' {
  if (!mime) return handle.startsWith('img_') ? 'image' : 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}
