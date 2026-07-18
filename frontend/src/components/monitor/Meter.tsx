import { useId } from 'react';
import { TONE_BAR, TONE_TEXT, type Tone } from './format';

/**
 * The two readout primitives the Monitor page is built from.
 *
 * Both are pure SVG/CSS with no chart library: the shapes are a bar and a filled line, and pulling
 * in a plotting dependency for them would cost more than it explains. Sizing is via `viewBox` +
 * `preserveAspectRatio="none"`, so a sparkline stretches to whatever column it lands in.
 */

/** A labelled horizontal meter — the page's unit of "how full is this". */
export function Meter({
  label,
  value,
  tone,
  detail,
  thin,
}: {
  label?: string;
  /** Percent 0-100. `null` renders an empty track, which reads as "unmeasured", not "zero". */
  value: number | null;
  tone: Tone;
  /** Right-hand secondary text (e.g. `11.2/12.0 GB`). */
  detail?: string;
  thin?: boolean;
}) {
  const filled = value === null ? 0 : Math.max(0, Math.min(100, value));

  return (
    <div>
      {(label || detail) && (
        <div className="mb-1 flex items-baseline gap-2 text-[11px]">
          {label && <span className="truncate text-slate-300">{label}</span>}
          <span className={`ml-auto shrink-0 font-mono ${TONE_TEXT[tone]}`}>
            {value === null ? '—' : `${Math.round(value)}%`}
          </span>
        </div>
      )}
      <div
        className={`w-full overflow-hidden rounded-full bg-black/40 ${thin ? 'h-1' : 'h-1.5'}`}
        role="meter"
        aria-valuenow={value ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${TONE_BAR[tone]}`}
          style={{ width: `${filled}%` }}
        />
      </div>
      {detail && <div className="mt-1 font-mono text-[10px] text-slate-500">{detail}</div>}
    </div>
  );
}

/**
 * A filled sparkline over the history buffer.
 *
 * Gaps matter here: the backend does not record a sample for a failed poll, so a machine that was
 * unreachable leaves a *hole* in the series. Drawing straight through it would invent data that was
 * never measured, so the path is broken into segments wherever a point is null or the time gap is
 * more than `gapMs`, and each segment is stroked separately.
 */
export function Sparkline({
  points,
  tone = 'ok',
  max = 100,
  height = 34,
  gapMs = 60_000,
}: {
  /** `[epochMs, value]` pairs, oldest first. A null value is an explicit hole. */
  points: [number, number | null][];
  tone?: Tone;
  /** Y ceiling. Percentages use 100; rates pass their own peak. */
  max?: number;
  height?: number;
  gapMs?: number;
}) {
  const gradientId = useId();
  const stroke = {
    ok: '#34d399',
    warn: '#f59e0b',
    critical: '#ef4444',
    idle: '#64748b',
  }[tone];

  if (points.length < 2) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-lg bg-black/20 text-[10px] text-slate-600"
      >
        collecting…
      </div>
    );
  }

  const t0 = points[0]![0];
  const t1 = points[points.length - 1]![0];
  const span = Math.max(1, t1 - t0);
  const ceiling = Math.max(max, 1);
  const x = (t: number) => ((t - t0) / span) * 100;
  const y = (v: number) => height - Math.max(0, Math.min(1, v / ceiling)) * height;

  // Split into contiguous runs, so an outage is a visible break rather than an interpolated line.
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  let prevT: number | null = null;
  for (const [t, v] of points) {
    if (v === null || (prevT !== null && t - prevT > gapMs)) {
      if (run.length) runs.push(run);
      run = [];
    }
    if (v !== null) run.push([t, v]);
    prevT = t;
  }
  if (run.length) runs.push(run);

  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className="w-full overflow-visible rounded-lg bg-black/20"
      style={{ height }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {runs.map((segment, i) => {
        const line = segment.map(([t, v]) => `${x(t).toFixed(2)},${y(v).toFixed(2)}`).join(' L ');
        const area = `M ${x(segment[0]![0]).toFixed(2)},${height} L ${line} L ${x(
          segment[segment.length - 1]![0],
        ).toFixed(2)},${height} Z`;
        return (
          <g key={i}>
            {segment.length > 1 && <path d={area} fill={`url(#${gradientId})`} />}
            <path
              d={`M ${line}`}
              fill="none"
              stroke={stroke}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </svg>
  );
}
