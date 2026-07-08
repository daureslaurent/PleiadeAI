import type { Monaco } from '@monaco-editor/react';

/**
 * `pleiade-dark` — the Monaco theme for the deep-space art direction (DIRECT_ART §2).
 *
 * Monaco's stock `vs-dark` paints an opaque `#1e1e1e`, which reads as a grey hole punched in the
 * glass. This theme makes the editor background fully transparent (`#00000000`) so the host well
 * (`bg-black/25`) shows through, and re-maps the token colors onto the palette: accent blue for
 * keywords/actions, reasoning purple for cognition-adjacent constructs (control flow), emerald for
 * strings, slate for structure. Cursor and selection are accent.
 */
export const PLEIADE_THEME = 'pleiade-dark';

let registered = false;

export function registerPleiadeTheme(monaco: Monaco): void {
  // Monaco keeps themes on a global registry; defining it twice is harmless but pointless.
  if (registered) return;
  registered = true;

  monaco.editor.defineTheme(PLEIADE_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '64748b', fontStyle: 'italic' }, // slate-500
      { token: 'keyword', foreground: '60a5fa' }, // accent-ish (blue-400)
      { token: 'keyword.control', foreground: 'c084fc' }, // reasoning (purple-400)
      { token: 'string', foreground: '34d399' }, // emerald-400
      { token: 'number', foreground: 'fbbf24' }, // amber-400
      { token: 'regexp', foreground: 'f472b6' },
      { token: 'type', foreground: '7dd3fc' },
      { token: 'type.identifier', foreground: '7dd3fc' },
      { token: 'identifier', foreground: 'e2e8f0' }, // slate-200
      { token: 'delimiter', foreground: '94a3b8' }, // slate-400
      { token: 'operator', foreground: '94a3b8' },
      // JSON
      { token: 'string.key.json', foreground: '60a5fa' },
      { token: 'string.value.json', foreground: '34d399' },
      // Dockerfile
      { token: 'keyword.dockerfile', foreground: '60a5fa' },
      { token: 'variable', foreground: 'fbbf24' },
    ],
    colors: {
      // Fully transparent: the glass well behind the editor is the background.
      'editor.background': '#00000000',
      'editor.foreground': '#e2e8f0',
      'editorLineNumber.foreground': '#475569', // slate-600
      'editorLineNumber.activeForeground': '#94a3b8',
      'editorCursor.foreground': '#3b82f6', // accent
      'editor.selectionBackground': '#3b82f640',
      'editor.inactiveSelectionBackground': '#3b82f620',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#ffffff10',
      'editorIndentGuide.activeBackground1': '#ffffff20',
      'editorWhitespace.foreground': '#ffffff12',
      'editorGutter.background': '#00000000',
      'editorWidget.background': '#111620',
      'editorWidget.border': '#ffffff12',
      'editorSuggestWidget.background': '#111620',
      'editorSuggestWidget.selectedBackground': '#3b82f626',
      'editorHoverWidget.background': '#111620',
      'scrollbarSlider.background': '#94a3b840',
      'scrollbarSlider.hoverBackground': '#94a3b873',
      'scrollbarSlider.activeBackground': '#94a3b899',
      'editorOverviewRuler.border': '#00000000',
    },
  });
}

/** Editor options shared by every Monaco mount: quiet chrome, no minimap, dense mono. */
export const MONACO_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  padding: { top: 12, bottom: 12 },
  renderLineHighlight: 'line' as const,
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
};
