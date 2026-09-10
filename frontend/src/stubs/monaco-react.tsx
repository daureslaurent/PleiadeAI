/**
 * Stand-in for `@monaco-editor/react` when `VITE_FEATURE_MONACO=0` (see `lib/features.ts`).
 *
 * Unreachable in practice — `components/CodeEditor.tsx` checks `MONACO_ENABLED` and renders its
 * textarea fallback without ever touching the lazy chunk — but the module still has to resolve, and
 * `EditorProps` is imported as a type across several views, so the shape is kept.
 */
export interface EditorProps {
  value?: string;
  defaultValue?: string;
  language?: string;
  defaultLanguage?: string;
  theme?: string;
  height?: string | number;
  width?: string | number;
  className?: string;
  options?: Record<string, unknown>;
  onChange?: (value: string | undefined) => void;
  onMount?: (...args: unknown[]) => void;
  beforeMount?: (...args: unknown[]) => void;
  loading?: React.ReactNode;
  [key: string]: unknown;
}

/** Mirrors the real package's `Monaco` type loosely enough for `lib/monacoTheme.ts`'s type-only use. */
export type Monaco = {
  editor: {
    defineTheme(name: string, theme: unknown): void;
    setTheme(name: string): void;
  };
};

export const loader = {
  config(_options: unknown): void {},
  init(): Promise<never> {
    return Promise.reject(new Error('Monaco was not included in this build.'));
  },
};

export default function Editor(_props: EditorProps): React.ReactElement | null {
  return null;
}
