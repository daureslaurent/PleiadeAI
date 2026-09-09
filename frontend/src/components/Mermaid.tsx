import { useEffect, useId, useState, type ReactNode } from 'react';
import { Code2, Maximize2, Workflow, X } from 'lucide-react';
import { usePrefs } from '../store/prefs';
import { themeById, type ThemeId } from '../theme/themes';

type MermaidApi = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidApi> | null = null;
/** Which app theme mermaid is currently configured for; `initialize` is only re-run on a change. */
let configuredFor: ThemeId | null = null;

/**
 * Load mermaid lazily (a heavy dep most turns never need) and configure it for the active theme.
 *
 * Mermaid bakes colours into the SVG it emits and cannot read a CSS variable, so a theme switch has
 * to re-`initialize` it and re-render every diagram — which is why `MermaidBlock`'s effect depends
 * on the theme id.
 */
function loadMermaid(themeId: ThemeId): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => mermaid);
  return mermaidPromise.then((mermaid) => {
    if (configuredFor !== themeId) {
      configuredFor = themeId;
      const t = themeById(themeId);
      mermaid.initialize({
        startOnLoad: false,
        // Agent output is untrusted: no inline HTML labels, no click handlers.
        securityLevel: 'strict',
        theme: t.mermaid.theme,
        fontFamily: 'var(--font-sans), ui-sans-serif, system-ui, sans-serif',
        themeVariables: {
          background: t.mermaid.background,
          primaryColor: t.mermaid.primaryColor,
          primaryTextColor: t.mermaid.primaryTextColor,
          primaryBorderColor: t.mermaid.primaryBorderColor,
          secondaryColor: t.mermaid.secondaryColor,
          tertiaryColor: t.mermaid.tertiaryColor,
          lineColor: t.mermaid.lineColor,
          textColor: t.mermaid.primaryTextColor,
        },
      });
    }
    return mermaid;
  });
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
  const themeId = usePrefs((s) => s.theme);

  useEffect(() => {
    let cancelled = false;
    // Debounce: while streaming, `code` changes on every token and each render is a full parse.
    const timer = setTimeout(() => {
      void (async () => {
        const mermaid = await loadMermaid(themeId);
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
    // `themeId`: mermaid bakes its palette into the SVG, so a theme switch has to re-render.
  }, [code, baseId, themeId]);

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
      <div className="group relative my-2 min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-panel">
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
          onClick={() => setZoomed(false)}
        >
          <button
            className="absolute right-4 top-4 rounded p-1.5 text-slate-400 hover:raise-3 hover:text-slate-100"
            onClick={() => setZoomed(false)}
          >
            <X size={18} />
          </button>
          <div
            className="mermaid-svg max-h-full max-w-full overflow-auto rounded-lg bg-panel p-6 [&_svg]:h-auto [&_svg]:w-full"
            onClick={(e) => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </>
  );
}
