import { useMemo, useId } from 'react';
import type { TrainMetric } from '../../lib/api';

/**
 * Training-loss curve, hand-rolled SVG (no chart dependency — see DIRECT_ART: dark-only glass,
 * accent blue for the line, mono for machine-produced numbers).
 *
 * Renders as a viewBox-normalized polyline so it scales fluidly with the card. Y is auto-scaled to
 * the observed loss range with a little padding; X is the metric index (steps may be sparse or
 * synthesized). `live` adds the shimmer treatment on the label — motion marks liveness only.
 */
const VB_W = 600;
const VB_H = 160;
const PAD = { top: 10, right: 8, bottom: 18, left: 34 };

export function LossChart({
  metrics,
  live = false,
  height = 160,
}: {
  metrics: TrainMetric[];
  live?: boolean;
  height?: number;
}) {
  const gradientId = useId();

  const geom = useMemo(() => {
    if (metrics.length < 2) return null;

    const losses = metrics.map((m) => m.loss).filter((l) => Number.isFinite(l));
    if (losses.length < 2) return null;

    const min = Math.min(...losses);
    const max = Math.max(...losses);
    // A flat series would divide by zero; give it a nominal band so the line sits mid-card.
    const span = max - min || Math.max(max * 0.1, 0.1);
    const lo = min - span * 0.1;
    const hi = max + span * 0.1;

    const plotW = VB_W - PAD.left - PAD.right;
    const plotH = VB_H - PAD.top - PAD.bottom;

    const x = (i: number) => PAD.left + (i / (metrics.length - 1)) * plotW;
    const y = (loss: number) => PAD.top + (1 - (loss - lo) / (hi - lo)) * plotH;

    const points = metrics.map((m, i) => `${x(i).toFixed(2)},${y(m.loss).toFixed(2)}`);
    const line = points.join(' ');
    // Close the path down to the baseline for the subtle area fill.
    const area = `${PAD.left},${PAD.top + plotH} ${line} ${x(metrics.length - 1)},${PAD.top + plotH}`;

    const last = metrics[metrics.length - 1]!;
    return {
      line,
      area,
      lo,
      hi,
      lastX: x(metrics.length - 1),
      lastY: y(last.loss),
      last,
      first: metrics[0]!,
    };
  }, [metrics]);

  if (!geom) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-white/[0.06] bg-black/20 text-[11px] text-slate-600"
        style={{ height }}
      >
        {live ? (
          <span className="text-shimmer">waiting for training metrics…</span>
        ) : (
          'no loss metrics captured'
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/20 p-2">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          {live ? <span className="text-shimmer">training loss</span> : 'training loss'}
        </span>
        <span className="font-mono text-[11px] text-slate-300">
          {geom.last.loss.toFixed(4)}
          {geom.last.epoch != null && (
            <span className="ml-2 text-slate-500">epoch {Number(geom.last.epoch).toFixed(2)}</span>
          )}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`Training loss curve, ${metrics.length} points, latest ${geom.last.loss.toFixed(4)}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(59 130 246)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="rgb(59 130 246)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Horizontal gridlines + y-axis labels (hi / mid / lo). */}
        {[0, 0.5, 1].map((t) => {
          const yy = PAD.top + t * (VB_H - PAD.top - PAD.bottom);
          const val = geom.hi - t * (geom.hi - geom.lo);
          return (
            <g key={t}>
              <line
                x1={PAD.left}
                y1={yy}
                x2={VB_W - PAD.right}
                y2={yy}
                stroke="rgba(255,255,255,0.06)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <text x={4} y={yy + 3} className="fill-slate-600" style={{ fontSize: 9 }}>
                {val.toFixed(2)}
              </text>
            </g>
          );
        })}

        <polyline points={geom.area} fill={`url(#${gradientId})`} stroke="none" />
        <polyline
          points={geom.line}
          fill="none"
          stroke="rgb(59 130 246)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* Head marker: pulses while the run is live. */}
        <circle
          cx={geom.lastX}
          cy={geom.lastY}
          r="3"
          className={live ? 'animate-glow-pulse' : ''}
          fill="rgb(59 130 246)"
          style={live ? ({ ['--glow' as string]: 'rgb(59 130 246)' } as React.CSSProperties) : undefined}
        />
      </svg>

      <div className="flex justify-between px-1 pt-0.5 font-mono text-[10px] text-slate-600">
        <span>step {geom.first.step}</span>
        <span>{metrics.length} pts</span>
        <span>step {geom.last.step}</span>
      </div>
    </div>
  );
}
