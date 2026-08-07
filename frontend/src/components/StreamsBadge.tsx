import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Radio, ExternalLink, Music, Video } from 'lucide-react';
import { streamsApi, type StreamInfo } from '../lib/api';
import { agentColor } from '../lib/agentColor';

/**
 * Header badge for live media streams (STREAMING_PLAN.md §5).
 *
 * Hidden entirely when nothing is on air — a command center should not carry a permanent control for
 * a feature that is usually idle. When a flow opens a stream the badge appears with a breathing
 * emerald dot; its popover lists what is live, and each entry pops the player out into its own
 * window rather than routing in place, because a stream is something you keep playing while you go
 * on working in the app behind it.
 */

const POLL_MS = 8000;
/** Faster while the popover is open, so buffer depth and now-playing read as live. */
const OPEN_POLL_MS = 3000;

const EMERALD_GLOW = { '--glow': 'rgba(52,211,153,0.45)' } as CSSProperties;

export function StreamsBadge() {
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const list = await streamsApi.list().catch(() => null);
      if (!cancelled && list) setStreams(list);
    };
    void load();
    const timer = window.setInterval(() => void load(), open ? OPEN_POLL_MS : POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const openPlayer = useCallback((stream: StreamInfo) => {
    setOpen(false);
    window.open(
      `/stream/${stream.flowId}?name=${encodeURIComponent(stream.flowName)}`,
      `pleiades-stream-${stream.flowId}`,
      'width=1100,height=720',
    );
  }, []);

  if (streams.length === 0) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={`${streams.length} live stream${streams.length === 1 ? '' : 's'}`}
        className="animate-glow-pulse flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.05] px-2.5 py-1 transition-colors hover:bg-white/[0.09]"
        style={EMERALD_GLOW}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.45)]" />
        <Radio size={12} className="text-emerald-300" />
        <span className="font-mono text-[11px] text-slate-300">{streams.length}</span>
      </button>

      {open && (
        <div className="glass-card animate-fade-up absolute right-0 top-full z-30 mt-2 w-80 rounded-2xl p-2">
          <div className="px-2 pb-1.5 pt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">
            On air
          </div>
          {streams.map((stream) => {
            const identity = agentColor(stream.flowName);
            const Icon = stream.kind === 'video' ? Video : Music;
            return (
              <button
                key={stream.flowId}
                onClick={() => openPlayer(stream)}
                className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/[0.05]"
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: identity.soft, color: identity.accent }}
                >
                  <Icon size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold tracking-wide" style={{ color: identity.accent }}>
                    {stream.flowName}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-slate-500">
                    {stream.nowPlaying ?? 'waiting for a clip…'}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="font-mono text-[10px] text-slate-500">
                    {stream.bufferedSec}s · {stream.listeners}👂
                  </span>
                  <ExternalLink size={11} className="text-slate-600 transition-colors group-hover:text-slate-300" />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
