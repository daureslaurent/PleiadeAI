import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Link2,
  Loader2,
  Maximize2,
  Play,
  Radio,
  RotateCw,
  Square,
  Timer,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { API_BASE, streamsApi, type StreamSession } from '../../lib/api';
import { agentColor } from '../../lib/agentColor';
import { useLiveStream } from './useLiveStream';
import { StreamVisualizer } from './StreamVisualizer';

/**
 * The live media player (STREAMING_PLAN.md §5).
 *
 * Everything about it assumes a flux with no end and no beginning: there is no scrubber, no
 * duration, and no seeking backwards — only "live" and "behind live". The transport bar is
 * consequently about *health* (how much material is buffered, how many clips are waiting, whether
 * the stream is re-airing its last clip) rather than position, because that is the only thing an
 * operator can act on while a generative radio is on air.
 */

/** Cadence for the metadata poll — now-playing and buffer depth change on clip boundaries. */
const META_POLL_MS = 4000;

interface Props {
  flowId: string;
  /** Called when the operator takes the stream off the air. */
  onStopped?: () => void;
}

export function LiveStreamPlayer({ flowId, onStopped }: Props) {
  const [session, setSession] = useState<StreamSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tunedIn, setTunedIn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [copied, setCopied] = useState(false);
  const [media, setMedia] = useState<HTMLMediaElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const kind = session?.kind ?? 'audio';
  const identity = useMemo(() => agentColor(session?.flowName ?? 'stream'), [session?.flowName]);
  const glow = { '--glow': `${identity.accent}44` } as CSSProperties;

  // The URL already carries its signed token (a media fetch can't send headers), so it is used
  // verbatim; only the API origin is prepended.
  const streamUrl = useMemo(() => (session ? absolute(session.url) : null), [session]);

  // Metadata poll. Kept separate from the byte stream: the flux is a single long-lived response and
  // learns nothing about clip titles, so now-playing has to come from the API.
  useEffect(() => {
    let cancelled = false;
    const load = async (first: boolean) => {
      try {
        const next = await streamsApi.get(flowId);
        if (cancelled) return;
        // Re-minting a token every poll would restart the fetch, so the URL is pinned to whatever
        // the first successful load returned.
        setSession((prev) => (prev ? { ...next, token: prev.token, url: prev.url } : next));
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        if (first) setLoadError(message(err));
      }
    };
    void load(true);
    const timer = window.setInterval(() => void load(false), META_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [flowId]);

  const live = useLiveStream(media, streamUrl, session?.mime ?? null, tunedIn);

  useEffect(() => {
    if (!media) return;
    media.volume = volume;
    media.muted = muted;
  }, [media, volume, muted]);

  const tuneIn = useCallback(() => {
    setTunedIn(true);
    // The play() has to ride the click: an endless stream is exactly what autoplay policy blocks.
    window.setTimeout(() => void media?.play().catch(() => undefined), 0);
  }, [media]);

  const stop = useCallback(async () => {
    await streamsApi.stop(flowId).catch(() => undefined);
    onStopped?.();
  }, [flowId, onStopped]);

  const copyUrl = useCallback(async () => {
    if (!streamUrl) return;
    await navigator.clipboard.writeText(streamUrl).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [streamUrl]);

  const toggleTimer = useCallback(async () => {
    if (!session) return;
    const next = await streamsApi.setTimer(flowId, !session.timerArmed).catch(() => null);
    if (next) setSession((prev) => (prev ? { ...prev, timerArmed: next.armed } : prev));
  }, [flowId, session]);

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="glass-card flex max-w-md flex-col items-center gap-3 rounded-2xl p-8 text-center">
          <AlertTriangle size={22} className="text-amber-400" />
          <p className="text-sm text-slate-300">{loadError}</p>
          <p className="text-xs text-slate-500">
            A stream exists only while its flow is feeding it. Run the flow, or arm its Time trigger.
          </p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={20} className="animate-spin text-slate-500" />
      </div>
    );
  }

  const playing = live.status === 'playing';
  const connecting = tunedIn && (live.status === 'connecting' || live.status === 'buffering');

  return (
    <div ref={shellRef} className="animate-fade-up flex h-full min-h-0 flex-col gap-3 p-4">
      {/* ---------------------------------------------------------------- surface */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/[0.07] bg-black/40"
        style={glow}
      >
        {kind === 'video' ? (
          <video
            ref={setMedia}
            playsInline
            className="h-full w-full bg-black object-contain"
          />
        ) : (
          <>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a generative radio has no captions */}
            <audio ref={setMedia} className="hidden" />
            <div className="absolute inset-0 flex items-end p-6">
              <StreamVisualizer media={media} accent={identity.accent} active={playing} />
            </div>
          </>
        )}

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 p-4">
          <LivePill starved={session.starved} behind={live.behind} playing={playing} />
          {session.starved && playing && (
            <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-[10px] uppercase tracking-wider text-amber-300">
              looping last clip
            </span>
          )}
        </div>

        {!tunedIn && (
          <button
            onClick={tuneIn}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40 backdrop-blur-sm transition-colors hover:bg-black/30"
          >
            <span
              className="animate-glow-pulse flex h-16 w-16 items-center justify-center rounded-full border border-white/20 bg-white/[0.06]"
              style={glow}
            >
              <Play size={26} className="ml-1 text-slate-100" />
            </span>
            <span className="text-xs uppercase tracking-[0.2em] text-slate-300">Tune in</span>
          </button>
        )}

        {connecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <div className="flex items-center gap-2 rounded-full bg-black/50 px-4 py-2 text-xs text-slate-300 backdrop-blur-sm">
              <Loader2 size={13} className="animate-spin" />
              <span className="text-shimmer">Connecting to the flux…</span>
            </div>
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------------- transport */}
      <div className="glass-card rounded-2xl px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Radio size={13} style={{ color: identity.accent }} />
              <span className="truncate text-sm font-semibold tracking-wide" style={{ color: identity.accent }}>
                {session.flowName}
              </span>
            </div>
            <div className={`truncate font-mono text-[11px] text-slate-400 ${playing ? 'text-shimmer' : ''}`}>
              {session.nowPlaying ?? 'waiting for the first clip…'}
            </div>
          </div>

          <BufferMeter
            bufferedSec={session.bufferedSec}
            queued={session.queuedClips}
            aheadSec={live.aheadSec}
            accent={identity.accent}
          />

          <div className="flex items-center gap-1">
            {live.behind && (
              <IconButton label="Jump to live" onClick={live.seekLive} tone="amber">
                <RotateCw size={14} />
              </IconButton>
            )}
            <IconButton label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted((m) => !m)}>
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label="Volume"
              className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-white/10 accent-slate-300"
            />
            <IconButton label={copied ? 'Copied' : 'Copy stream URL'} onClick={() => void copyUrl()}>
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            </IconButton>
            <IconButton
              label="Fullscreen"
              onClick={() => void shellRef.current?.requestFullscreen?.().catch(() => undefined)}
            >
              <Maximize2 size={14} />
            </IconButton>
            <IconButton
              label={session.timerArmed ? 'Stop feeding this stream' : 'Keep feeding this stream'}
              onClick={() => void toggleTimer()}
              tone={session.timerArmed ? 'emerald' : undefined}
            >
              <Timer size={14} />
            </IconButton>
            <IconButton label="Take off the air" onClick={() => void stop()} tone="red">
              <Square size={14} />
            </IconButton>
          </div>
        </div>

        {live.error && live.status !== 'playing' && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-400">
            <AlertTriangle size={11} />
            <span>{live.error}</span>
            <button onClick={live.reconnect} className="ml-1 underline decoration-dotted hover:text-amber-300">
              retry now
            </button>
          </div>
        )}

        {session.recent.length > 0 && (
          <div className="mt-3 border-t border-white/[0.06] pt-2">
            <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-slate-500">Recently aired</div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {session.recent.map((clip) => (
                <div
                  key={`${clip.id}-${clip.airedAt ?? ''}`}
                  className="shrink-0 rounded-xl border border-white/[0.06] bg-black/25 px-3 py-1.5"
                  title={clip.replays > 0 ? `re-aired ${clip.replays}×` : undefined}
                >
                  <div className="max-w-[16rem] truncate text-[11px] text-slate-300">{clip.title}</div>
                  <div className="font-mono text-[10px] text-slate-500">
                    {clip.durationSec.toFixed(1)}s{clip.replays > 0 ? ` · ×${clip.replays + 1}` : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-slate-600">
          <Link2 size={10} />
          <span className="truncate">{streamUrl?.replace(/\?t=.*/, '?t=…')}</span>
        </div>
      </div>
    </div>
  );
}

/** The one loud state marker: live, drifting, or off. */
function LivePill({ starved, behind, playing }: { starved: boolean; behind: boolean; playing: boolean }) {
  const tone = !playing
    ? { dot: 'bg-slate-600', text: 'text-slate-400', label: 'OFF AIR', glow: 'transparent' }
    : behind
      ? { dot: 'bg-amber-400', text: 'text-amber-300', label: 'BEHIND', glow: 'rgba(245,158,11,0.45)' }
      : starved
        ? { dot: 'bg-amber-400', text: 'text-amber-300', label: 'LIVE', glow: 'rgba(245,158,11,0.45)' }
        : { dot: 'bg-emerald-400', text: 'text-emerald-300', label: 'LIVE', glow: 'rgba(52,211,153,0.45)' };
  return (
    <span
      className={`pointer-events-none flex items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1 backdrop-blur-sm ${playing ? 'animate-glow-pulse' : ''}`}
      style={{ '--glow': tone.glow } as CSSProperties}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      <span className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${tone.text}`}>{tone.label}</span>
    </span>
  );
}

/**
 * Buffer health, which on a live stream stands in for a progress bar: how much decoded audio is
 * ahead of the playhead, and how much un-aired material the backend is still holding.
 */
function BufferMeter({
  bufferedSec,
  queued,
  aheadSec,
  accent,
}: {
  bufferedSec: number;
  queued: number;
  aheadSec: number;
  accent: string;
}) {
  // 60s of queued material is a comfortable cushion; past it the bar simply reads full.
  const fill = Math.min(100, (bufferedSec / 60) * 100);
  return (
    <div className="flex items-center gap-2" title={`${aheadSec.toFixed(0)}s decoded ahead of the playhead`}>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${fill}%`, background: accent }}
        />
      </div>
      <span className="whitespace-nowrap font-mono text-[10px] text-slate-500">
        {bufferedSec}s · {queued} queued
      </span>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  tone,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  tone?: 'amber' | 'red' | 'emerald';
}) {
  const toneClass =
    tone === 'red'
      ? 'text-slate-400 hover:bg-red-500/15 hover:text-red-400'
      : tone === 'amber'
        ? 'text-amber-400 hover:bg-amber-500/15'
        : tone === 'emerald'
          ? 'text-emerald-400 hover:bg-emerald-500/15'
          : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-200';
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors active:scale-95 ${toneClass}`}
    >
      {children}
    </button>
  );
}

function absolute(path: string): string {
  if (API_BASE.startsWith('http')) return `${API_BASE}${path}`;
  return new URL(`${API_BASE}${path}`, window.location.origin).href;
}

function message(err: unknown): string {
  if (typeof err === 'object' && err && 'response' in err) {
    const res = (err as { response?: { data?: { error?: string }; status?: number } }).response;
    if (res?.data?.error) return res.data.error;
    if (res?.status === 404) return 'this flow has no live stream';
  }
  return err instanceof Error ? err.message : 'could not load the stream';
}
