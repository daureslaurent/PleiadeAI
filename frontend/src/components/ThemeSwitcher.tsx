import { useEffect, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { usePrefs } from '../store/prefs';
import { THEMES } from '../theme/themes';

/**
 * A theme popover pinned in the sidebar footer.
 *
 * Choosing a theme is something you do to *look* at it, so a round trip through Settings is the
 * wrong affordance — the full picker (with the layout choice and the previews) still lives at
 * `/settings/interface`. This is the same list, one line each, next to the page it changes.
 */
export function ThemeSwitcher({ collapsed }: { collapsed: boolean }) {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Dismiss on an outside click or Escape — a popover that only closes by re-clicking its trigger
  // reads as stuck.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = THEMES.find((t) => t.id === theme);

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={collapsed ? `Theme — ${active?.label}` : undefined}
        className={`flex w-full items-center rounded-lg py-2 text-xs text-slate-400 transition-colors hover:raise-2 hover:text-slate-100 ${
          collapsed ? 'justify-center px-2' : 'gap-2 px-3'
        }`}
      >
        <Palette size={15} />
        {!collapsed && (
          <>
            <span>Theme</span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="text-[11px] text-slate-500">{active?.label}</span>
              <span
                className="h-3 w-3 rounded-full ring-1 ring-inset ring-hairline-strong"
                style={{ background: active?.swatch[2] }}
              />
            </span>
          </>
        )}
      </button>

      {open && (
        <div className="glass-popover absolute bottom-full left-0 z-30 mb-1.5 w-52 overflow-hidden rounded-xl border py-1">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTheme(t.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:raise-2 ${
                t.id === theme ? 'text-accent' : 'text-slate-300'
              }`}
            >
              {/* The three colours the theme is actually made of, painted literally. */}
              <span className="flex shrink-0 overflow-hidden rounded-full ring-1 ring-inset ring-hairline-strong">
                {t.swatch.map((c) => (
                  <span key={c} className="h-3 w-2" style={{ background: c }} />
                ))}
              </span>
              <span className="min-w-0 flex-1 truncate">{t.label}</span>
              {t.id === theme && <Check size={12} className="shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
