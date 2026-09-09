import { create } from 'zustand';
import { applyTheme } from '../theme/apply';
import { DEFAULT_THEME, isThemeId, type ThemeId } from '../theme/themes';
import { DEFAULT_CHAT_LAYOUT, isChatLayoutId, type ChatLayoutId } from '../theme/layouts';
import { settingsApi } from '../lib/api';

/**
 * UI preferences, held in localStorage and applied instantly.
 *
 * Two kinds live here. Most are display toggles that only make sense on *this* device and never
 * leave it. **Appearance** — the theme and the chat layout — is different: it is an operator
 * preference that should follow them to another browser, so it is *also* stored on the settings
 * singleton (`ui_theme` / `ui_chat_layout`). localStorage stays the fast path that lets
 * `index.html` paint the right theme before the first API call; the server is the source of truth
 * once one has been made (see `adoptServerAppearance`).
 */

const KEY = 'pleiades.prefs.v1';

interface PersistedPrefs {
  /** App-wide theme (src/theme/themes.ts). Mirrored to `settings.ui_theme`. */
  theme: ThemeId;
  /** Chat page structure (src/theme/layouts.ts). Mirrored to `settings.ui_chat_layout`. */
  chatLayout: ChatLayoutId;
  /** Show the collapsible `<think>` reasoning block for delegated sub-agents (top-level always shows). */
  showSubagentThinking: boolean;
  /**
   * How many conversations the Workspace navigator lists per agent before it hides the rest behind
   * "Show more" — and the page size each of those clicks fetches.
   */
  sessionsPerAgent: number;
}

const DEFAULTS: PersistedPrefs = {
  theme: DEFAULT_THEME,
  chatLayout: DEFAULT_CHAT_LAYOUT,
  showSubagentThinking: true,
  sessionsPerAgent: 5,
};

/** The persisted surface, derived from the defaults so adding a field can never drop another. */
const PERSISTED_KEYS = Object.keys(DEFAULTS) as (keyof PersistedPrefs)[];

/** Bounds on the page size: one is a legal (if odd) choice, 50 is where a sidebar stops being one. */
export const SESSIONS_PER_AGENT_MIN = 1;
export const SESSIONS_PER_AGENT_MAX = 50;

function load(): PersistedPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    const stored = raw ? (JSON.parse(raw) as Partial<PersistedPrefs>) : {};
    return {
      ...DEFAULTS,
      ...stored,
      // A theme or layout that no longer exists (renamed, or written by a newer build) must fall
      // back rather than leave the document with a `data-theme` nothing styles.
      theme: isThemeId(stored.theme) ? stored.theme : DEFAULTS.theme,
      chatLayout: isChatLayoutId(stored.chatLayout) ? stored.chatLayout : DEFAULTS.chatLayout,
    };
  } catch {
    return DEFAULTS;
  }
}

interface PrefsState extends PersistedPrefs {
  setTheme: (v: ThemeId) => void;
  setChatLayout: (v: ChatLayoutId) => void;
  setShowSubagentThinking: (v: boolean) => void;
  setSessionsPerAgent: (v: number) => void;
  /** Adopt the appearance stored on the server, if it differs. See `AuthGuard`. */
  adoptServerAppearance: (theme: unknown, layout: unknown) => void;
}

export const usePrefs = create<PrefsState>((set, get) => {
  /** Write the persisted subset back — every field, so adding one never drops another. */
  const persist = () => {
    const state = get();
    const out = Object.fromEntries(PERSISTED_KEYS.map((k) => [k, state[k]]));
    try {
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  };

  /** Mirror an appearance choice to the settings doc. Fire-and-forget: the local value already
   *  won, and a failed sync must not undo what the operator just saw happen. */
  const push = (patch: { ui_theme?: ThemeId; ui_chat_layout?: ChatLayoutId }) => {
    void settingsApi.update(patch).catch(() => {
      /* offline, or not authenticated yet — localStorage still holds the choice */
    });
  };

  return {
    ...load(),
    setTheme: (v) => {
      if (!isThemeId(v) || get().theme === v) return;
      set({ theme: v });
      applyTheme(v);
      persist();
      push({ ui_theme: v });
    },
    setChatLayout: (v) => {
      if (!isChatLayoutId(v) || get().chatLayout === v) return;
      set({ chatLayout: v });
      persist();
      push({ ui_chat_layout: v });
    },
    adoptServerAppearance: (theme, layout) => {
      const next: Partial<PersistedPrefs> = {};
      if (isThemeId(theme) && theme !== get().theme) next.theme = theme;
      if (isChatLayoutId(layout) && layout !== get().chatLayout) next.chatLayout = layout;
      if (!Object.keys(next).length) return;
      set(next);
      if (next.theme) applyTheme(next.theme);
      persist();
    },
    setShowSubagentThinking: (v) => {
      set({ showSubagentThinking: v });
      persist();
    },
    setSessionsPerAgent: (v) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) return;
      set({
        sessionsPerAgent: Math.min(SESSIONS_PER_AGENT_MAX, Math.max(SESSIONS_PER_AGENT_MIN, n)),
      });
      persist();
    },
  };
});

/** Re-stamp the document from the stored value. Called once at boot, after `index.html`'s inline
 *  bootstrap, so a value the inline script could not parse still converges. */
export function initTheme(): void {
  applyTheme(usePrefs.getState().theme);
}
