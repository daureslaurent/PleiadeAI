import { lazy, Suspense } from 'react';
import type { EditorProps } from '@monaco-editor/react';

// The real editor lives in its own chunk (Monaco is ~5 MB). Importing it lazily keeps Monaco out of
// the main bundle — it only downloads when a view that renders a CodeEditor is opened. The Monaco
// loader/worker setup (lib/monacoSetup) is a side-effect import inside that chunk, so it also loads
// on demand.
const MonacoEditor = lazy(() => import('./MonacoEditor'));

/** Drop-in replacement for @monaco-editor/react's <Editor>, lazily loaded. */
export default function CodeEditor(props: EditorProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-[120px] items-center justify-center text-[11px] text-slate-500">
          Loading editor…
        </div>
      }
    >
      <MonacoEditor {...props} />
    </Suspense>
  );
}
