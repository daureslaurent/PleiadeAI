import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

/**
 * Height-clamped content with a "Show more" affordance.
 *
 * A long chat turn used to push everything else off-screen, so scrolling back through a session
 * meant scrolling past walls of prose and tool output. Anything taller than `maxHeight` is clamped
 * and faded out (a CSS mask, so it works over the bubble gradient *and* the starfield alike), with a
 * pill that expands it in place. Content that fits renders untouched — no button, no wrapper cost.
 *
 * The measurement is live (ResizeObserver): a turn that grows past the threshold later — an image
 * finishing decode, a tool card opening — starts offering the affordance without a remount.
 */
export function Collapsible({
  maxHeight = 340,
  /** Slack before clamping: a turn barely over the line is not worth a button. */
  slack = 80,
  tone = 'default',
  children,
}: {
  maxHeight?: number;
  slack?: number;
  /** `bubble` sits on the user's tinted bubble, so its pill borrows white instead of slate. */
  tone?: 'default' | 'bubble';
  children: React.ReactNode;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(0);
  const [open, setOpen] = useState(false);

  const measure = useCallback(() => {
    const el = innerRef.current;
    if (el) setFull(el.scrollHeight);
  }, []);

  useEffect(() => {
    const el = innerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      measure();
      return;
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const clampable = full > maxHeight + slack;
  const clamped = clampable && !open;

  return (
    <div className="min-w-0">
      <div
        className="min-w-0 transition-[max-height] duration-200"
        style={
          clamped
            ? {
                maxHeight,
                overflow: 'hidden',
                maskImage: 'linear-gradient(to bottom, #000 calc(100% - 72px), transparent)',
                WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 72px), transparent)',
              }
            : undefined
        }
      >
        <div ref={innerRef} className="min-w-0">
          {children}
        </div>
      </div>
      {clampable && (
        <button
          onClick={() => setOpen((o) => !o)}
          className={[
            'mt-1 flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
            tone === 'bubble'
              ? 'border-white/20 text-white/80 hover:bg-white/10 hover:text-white'
              : 'border-white/10 text-slate-400 hover:border-white/20 hover:bg-white/[0.06] hover:text-slate-200',
          ].join(' ')}
        >
          {clamped ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          {clamped ? 'Show more' : 'Show less'}
          {clamped && (
            <span className={tone === 'bubble' ? 'text-white/50' : 'text-slate-600'}>
              · {Math.round((full - maxHeight) / 22)} more lines
            </span>
          )}
        </button>
      )}
    </div>
  );
}
