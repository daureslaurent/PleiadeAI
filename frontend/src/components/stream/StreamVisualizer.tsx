import { useEffect, useRef } from 'react';

/**
 * A spectrum for an audio-only stream — the picture a music channel has instead of pictures.
 *
 * Reads the element through a WebAudio `AnalyserNode`. `createMediaElementSource` may be called only
 * once per element and permanently reroutes its output through the graph, so the node is created
 * lazily, cached on the element itself, and always kept connected to the destination — dropping that
 * connection would silence the stream rather than merely stop the drawing.
 */

interface Props {
  media: HTMLMediaElement | null;
  /** The stream's identity hue, threaded through from `agentColor` (DIRECT_ART §2). */
  accent: string;
  /** Freezes the animation when the stream isn't actually playing (DIRECT_ART §6: animate liveness only). */
  active: boolean;
}

/** Cache of the per-element WebAudio graph, so remounting the player doesn't try to tap it twice. */
const graphs = new WeakMap<HTMLMediaElement, { ctx: AudioContext; analyser: AnalyserNode }>();

function graphFor(media: HTMLMediaElement): { ctx: AudioContext; analyser: AnalyserNode } | null {
  const existing = graphs.get(media);
  if (existing) return existing;
  try {
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(media);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const graph = { ctx, analyser };
    graphs.set(media, graph);
    return graph;
  } catch {
    return null;
  }
}

export function StreamVisualizer({ media, accent, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !media) return;
    const graph = graphFor(media);
    if (!graph) return;
    // Autoplay policy suspends a context created before the user gesture; resuming is a no-op once
    // it is already running.
    void graph.ctx.resume().catch(() => undefined);

    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const bins = new Uint8Array(graph.analyser.frequencyBinCount);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth * dpr;
      const height = canvas.clientHeight * dpr;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx2d.clearRect(0, 0, width, height);
      if (active && !reduced) graph.analyser.getByteFrequencyData(bins);
      else bins.fill(0);

      // Only the lower two thirds of the spectrum carries anything musical; the top bins are
      // near-silent on AAC and would render as a dead flat tail.
      const used = Math.floor(bins.length * 0.66);
      const barWidth = width / used;
      for (let i = 0; i < used; i += 1) {
        const value = bins[i] ?? 0;
        const barHeight = Math.max(2 * dpr, (value / 255) * height * 0.9);
        const alpha = 0.25 + (value / 255) * 0.75;
        ctx2d.fillStyle = accent;
        ctx2d.globalAlpha = alpha;
        ctx2d.fillRect(i * barWidth + barWidth * 0.2, height - barHeight, barWidth * 0.6, barHeight);
      }
      ctx2d.globalAlpha = 1;
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [media, accent, active]);

  return <canvas ref={canvasRef} className="h-full w-full" aria-hidden />;
}
