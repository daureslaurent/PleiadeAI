import type { Monaco } from '@monaco-editor/react';
import { THEMES, themeById, type ThemeId } from '../theme/themes';
import { usePrefs } from '../store/prefs';

/**
 * Monaco, re-skinned per app theme (THEME_SYSTEM_PLAN.md §1.5).
 *
 * Monaco owns its own colour registry and cannot read a CSS variable, so it is the one place a
 * theme's palette has to be restated in hex. Each app theme contributes a `monaco` block
 * (`src/theme/themes.ts`) and this module turns it into a registered Monaco theme.
 *
 * The editor background stays fully transparent (`#00000000`) in every theme so the host well
 * (the `.well` utility) shows through — Monaco's stock grounds would punch an opaque hole in the
 * page.
 */

/** The registered Monaco theme name for an app theme. */
export const monacoThemeName = (id: ThemeId): string => `pleiades-${id}`;

let registered = false;

/**
 * Define every theme at once, on the first editor mount. Monaco keeps themes on a global registry
 * and switching is a name lookup, so registering all five up front costs nothing and means a theme
 * change never has to remount an editor.
 */
export function registerThemes(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  for (const theme of THEMES) {
    const m = theme.monaco;
    const dark = theme.mode === 'dark';
    // Overlays the editor paints on top of the host surface: they must lighten on a dark ground
    // and darken on a light one, or indent guides and whitespace dots vanish.
    const veil = (alpha: string) => (dark ? `#ffffff${alpha}` : `#000000${alpha}`);

    monaco.editor.defineTheme(monacoThemeName(theme.id), {
      base: m.base,
      inherit: true,
      rules: [
        { token: 'comment', foreground: m.comment, fontStyle: 'italic' },
        { token: 'keyword', foreground: m.keyword },
        { token: 'keyword.control', foreground: m.control },
        { token: 'string', foreground: m.string },
        { token: 'number', foreground: m.number },
        { token: 'regexp', foreground: m.control },
        { token: 'type', foreground: m.type },
        { token: 'type.identifier', foreground: m.type },
        { token: 'identifier', foreground: m.fg },
        { token: 'delimiter', foreground: m.punctuation },
        { token: 'operator', foreground: m.punctuation },
        // JSON
        { token: 'string.key.json', foreground: m.keyword },
        { token: 'string.value.json', foreground: m.string },
        // Dockerfile
        { token: 'keyword.dockerfile', foreground: m.keyword },
        { token: 'variable', foreground: m.number },
      ],
      colors: {
        // Fully transparent: the well behind the editor is the background.
        'editor.background': '#00000000',
        'editor.foreground': `#${m.fg}`,
        'editorLineNumber.foreground': `#${m.comment}`,
        'editorLineNumber.activeForeground': `#${m.punctuation}`,
        'editorCursor.foreground': `#${m.keyword}`,
        'editor.selectionBackground': `#${m.selection}`,
        'editor.inactiveSelectionBackground': `#${m.selection.slice(0, 6)}20`,
        'editor.lineHighlightBackground': `#${m.lineHighlight}`,
        'editor.lineHighlightBorder': '#00000000',
        'editorIndentGuide.background1': veil('10'),
        'editorIndentGuide.activeBackground1': veil('20'),
        'editorWhitespace.foreground': veil('12'),
        'editorGutter.background': '#00000000',
        // The popups float over the page rather than over the well, so they need a real ground.
        'editorWidget.background': theme.swatch[1],
        'editorWidget.border': veil('12'),
        'editorSuggestWidget.background': theme.swatch[1],
        'editorSuggestWidget.selectedBackground': `#${m.selection.slice(0, 6)}26`,
        'editorHoverWidget.background': theme.swatch[1],
        'scrollbarSlider.background': `#${m.punctuation}40`,
        'scrollbarSlider.hoverBackground': `#${m.punctuation}73`,
        'scrollbarSlider.activeBackground': `#${m.punctuation}99`,
        'editorOverviewRuler.border': '#00000000',
      },
    });
  }
}

/** The Monaco theme name to hand an editor for the active app theme. */
export const monacoThemeFor = (id: string | undefined): string => monacoThemeName(themeById(id).id);

/** The Monaco theme name for whatever theme the app is wearing right now. Re-renders on a switch. */
export const useMonacoTheme = (): string => monacoThemeFor(usePrefs((s) => s.theme));

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
