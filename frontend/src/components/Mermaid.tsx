import { useEffect, useId, useState, type ReactNode } from 'react';
import { Code2, Maximize2, Workflow, X } from 'lucide-react';

type MermaidApi = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidApi> | null = null;

/** Load + initialize mermaid once, lazily — it is a heavy dep and most turns never need it. */
function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // Agent output is untrusted: no inline HTML labels, no click handlers.
      securityLevel: 'strict',
      theme: 'dark',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      themeVariables: {
        background: '#0f1419',
        primaryColor: '#161b22',
        primaryTextColor: '#e2e8f0',
        primaryBorderColor: '#3b82f6',
        secondaryColor: '#1e293b',
        tertiaryColor: '#0f1419',
        lineColor: '#64748b',
        textColor: '#cbd5e1',
      },
    });
    return mermaid;
  });
  return mermaidPromise;
}

let renderSeq = 0;

/**
 * Renders a ```mermaid fence as a diagram, falling back to the plain code block while the
 * source is still mid-stream (and therefore unparseable) or genuinely invalid.
 */
export function MermaidBlock({ code, fallback }: { code: string; fallback: ReactNode }) {
  const [svg, setSvg] = useState('');
  const [view, setView] = useState<'diagram' | 'code'>('diagram');
  const [zoomed, setZoomed] = useState(false);
  const baseId = useId().replace(/[^a-zA-Z0-9]/g, '');

  useEffect(() => {
    let cancelled = false;
    // Debounce: while streaming, `code` changes on every token and each render is a full parse.
    const timer = setTimeout(() => {
      void (async () => {
        const mermaid = await loadMermaid();
        if (cancelled) return;
        const valid = await mermaid.parse(code, { suppressErrors: true });
        if (cancelled || !valid) return;
        try {
          const out = await mermaid.render(`mmd-${baseId}-${renderSeq++}`, code);
          if (!cancelled) setSvg(out.svg);
        } catch {
          /* keep the last good diagram; the fence may still be growing */
        }
      })();
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, baseId]);

  // Nothing renderable yet — show the source so the user still sees something streaming in.
  if (!svg) return <>{fallback}</>;

  const diagram = (
    <div
      className="mermaid-svg flex justify-center overflow-x-auto p-4 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );

  return (
    <>
      <div className="group relative my-2 min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-[#0d1117]">
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-slate-500">
            mermaid
          </span>
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={() => setView(view === 'diagram' ? 'code' : 'diagram')}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-slate-200"
            >
              {view === 'diagram' ? <Code2 size={12} /> : <Workflow size={12} />}
              {view === 'diagram' ? 'Source' : 'Diagram'}
            </button>
            <button
              onClick={() => setZoomed(true)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-slate-200"
            >
              <Maximize2 size={12} />
              Expand
            </button>
          </div>
        </div>
        {view === 'diagram' ? diagram : <div className="[&>div]:my-0 [&>div]:border-0">{fallback}</div>}
      </div>

      {zoomed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm"
          onClick={() => setZoomed(false)}
        >
          <button
            className="absolute right-4 top-4 rounded p-1.5 text-slate-400 hover:bg-white/10 hover:text-slate-100"
            onClick={() => setZoomed(false)}
          >
            <X size={18} />
          </button>
          <div
            className="mermaid-svg max-h-full max-w-full overflow-auto rounded-lg bg-[#0d1117] p-6 [&_svg]:h-auto [&_svg]:w-full"
            onClick={(e) => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </>
  );
}
