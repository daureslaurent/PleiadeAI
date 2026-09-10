import { lazy, Suspense } from 'react';
import type { EditorProps } from '@monaco-editor/react';
import { MONACO_ENABLED } from '../lib/features';

// The real editor lives in its own chunk (Monaco is ~5 MB). Importing it lazily keeps Monaco out of
// the main bundle — it only downloads when a view that renders a CodeEditor is opened. The Monaco
// loader/worker setup (lib/monacoSetup) is a side-effect import inside that chunk, so it also loads
// on demand.
const MonacoEditor = lazy(() => import('./MonacoEditor'));

/**
 * Plain-textarea stand-in used when Monaco was compiled out (`VITE_FEATURE_MONACO=0`).
 *
 * It honours the same `value`/`defaultValue`/`onChange` contract as the real editor, so every call
 * site keeps working — you lose syntax highlighting and the gutter, not the ability to edit. The
 * height prop is passed through since callers size the editor rather than its container.
 */
function PlainTextEditor({ value, defaultValue, onChange, height, className }: EditorProps) {
  // Monaco's `onChange` takes a second argument — the model-change event. No call site reads it, and
  // a textarea has nothing to put there, so the handler is narrowed to its first parameter.
  const emit = onChange as ((value: string | undefined) => void) | undefined;
  return (
    <textarea
      value={value}
      defaultValue={defaultValue}
      onChange={(e) => emit?.(e.target.value)}
      spellCheck={false}
      style={{ height: height ?? '100%' }}
      className={`w-full resize-none rounded-md border border-border bg-panel p-3 font-mono text-[12px] leading-relaxed text-slate-200 outline-none focus:border-border ${className ?? ''}`}
    />
  );
}

/** Drop-in replacement for @monaco-editor/react's <Editor>, lazily loaded. */
export default function CodeEditor(props: EditorProps) {
  // A build-time literal, so when Monaco is off the `lazy` chunk below is unreachable and Rollup
  // drops it along with the (already stubbed) package.
  if (!MONACO_ENABLED) return <PlainTextEditor {...props} />;

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
