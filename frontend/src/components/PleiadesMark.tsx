/**
 * The brand mark: the Pleiades (M45) itself.
 *
 * The nine brightest members, at their true relative sky positions and sized by their true
 * magnitude — so this is the actual asterism, not a handful of decorative sparkles. Positions are
 * the stars' RA/Dec projected to the sky plane (1 min of RA = 15′·cos δ, east to the left) under a
 * *uniform* scale, which is what preserves the shape: the little-dipper bowl of Alcyone, Merope,
 * Electra and Maia, with the tight Atlas/Pleione pair trailing off as the handle. The whole cluster
 * is tilted 20° to fill a square tile — legitimate, since its orientation in the sky rotates
 * through the night anyway.
 *
 * Palette follows the deep-space theme in index.css: accent-blue nebulosity (the real cluster's
 * reflection nebula is blue) behind white stars. The faint sisters twinkle on the shared `twinkle`
 * keyframe, staggered; the bright ones hold steady so the mark stays legible at 20px.
 * `prefers-reduced-motion` kills the animation via the global rule in index.css.
 */

interface Star {
  name: string;
  cx: number;
  cy: number;
  /** Radius in viewBox units, from apparent magnitude (brighter ⇒ larger). */
  r: number;
  /** Faint sisters shimmer; the bright ones stay put. */
  twinkle?: boolean;
}

/** Alcyone — brightest of the cluster, and the only star that earns diffraction spikes. */
const ALCYONE: Star = { name: 'Alcyone', cx: 10.28, cy: 15.45, r: 1.6 };

// mag: Alcyone 2.87, Atlas 3.62, Electra 3.70, Maia 3.87, Merope 4.18,
//      Taygeta 4.30, Pleione 5.05, Celaeno 5.45, Sterope 5.76
const STARS: Star[] = [
  ALCYONE,
  { name: 'Atlas', cx: 3.81, cy: 18.84, r: 1.25 },
  { name: 'Electra', cx: 20.8, cy: 11.45, r: 1.2 },
  { name: 'Maia', cx: 15.32, cy: 8.34, r: 1.15 },
  { name: 'Merope', cx: 15.94, cy: 16.54, r: 1.05 },
  { name: 'Taygeta', cx: 17.17, cy: 5.67, r: 1.0 },
  { name: 'Pleione', cx: 3.2, cy: 17.39, r: 0.78, twinkle: true },
  { name: 'Celaeno', cx: 19.93, cy: 8.23, r: 0.66, twinkle: true },
  { name: 'Sterope', cx: 13.78, cy: 5.16, r: 0.58, twinkle: true },
];

const SPIKE = 3.6;

export function PleiadesMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="PleiadesAI"
      fill="none"
    >
      <defs>
        {/* Reflection nebula — the blue wash the real cluster is wrapped in. */}
        <radialGradient id="pm-nebula">
          <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </radialGradient>
        {/* Bloom: blurred copy of the stars, laid under the crisp cores. */}
        <filter id="pm-bloom" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.1" />
        </filter>
      </defs>

      <ellipse cx="12" cy="12" rx="11" ry="9" fill="url(#pm-nebula)" transform="rotate(-20 12 12)" />

      {/* Halo pass — soft, blue, and generous. */}
      <g filter="url(#pm-bloom)" fill="#93c5fd" opacity="0.75">
        {STARS.map((s) => (
          <circle key={s.name} cx={s.cx} cy={s.cy} r={s.r * 0.9} />
        ))}
      </g>

      {/* Alcyone's spikes, under the cores so its centre stays crisp. */}
      <g stroke="#bfdbfe" strokeOpacity="0.5" strokeWidth="0.3" strokeLinecap="round">
        <line x1={ALCYONE.cx - SPIKE} y1={ALCYONE.cy} x2={ALCYONE.cx + SPIKE} y2={ALCYONE.cy} />
        <line x1={ALCYONE.cx} y1={ALCYONE.cy - SPIKE} x2={ALCYONE.cx} y2={ALCYONE.cy + SPIKE} />
      </g>

      {/* Cores — hard white discs, the thing that survives at 20px. */}
      <g fill="#ffffff">
        {STARS.map((s, i) => (
          <circle
            key={s.name}
            cx={s.cx}
            cy={s.cy}
            r={s.r * 0.5}
            className={s.twinkle ? 'animate-twinkle' : undefined}
            // Stagger the shimmer so the faint sisters never pulse in lockstep.
            style={s.twinkle ? { animationDelay: `${i * 0.7}s` } : undefined}
          />
        ))}
      </g>
    </svg>
  );
}
