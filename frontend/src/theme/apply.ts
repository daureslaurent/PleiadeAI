import { DEFAULT_THEME, themeById, type ThemeId } from './themes';

/**
 * Stamp a theme onto the document (THEME_SYSTEM_PLAN.md §2.1).
 *
 * Three things have to agree: the `data-theme` attribute every `themes/*.css` block keys off, the
 * `dark` class (Tailwind's `dark:` variant and any library that sniffs it), and the browser-chrome
 * colour. `index.html` runs the same logic inline before the bundle loads so the first paint is
 * already correct — this function is what keeps it correct afterwards.
 */
export function applyTheme(id: ThemeId = DEFAULT_THEME): void {
  const theme = themeById(id);
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.classList.toggle('dark', theme.mode === 'dark');
  root.style.colorScheme = theme.mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.themeColor);
}
