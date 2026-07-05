import { create } from 'zustand';

/**
 * Client-side UI preferences (display-only, persisted to localStorage — never sent to the backend).
 * Kept separate from the backend-backed inference `settings` so a view toggle needs no API/migration.
 */

const KEY = 'pleiade.prefs.v1';

interface PersistedPrefs {
  /** Show the collapsible `<think>` reasoning block for delegated sub-agents (top-level always shows). */
  showSubagentThinking: boolean;
}

const DEFAULTS: PersistedPrefs = {
  showSubagentThinking: true,
};

function load(): PersistedPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PersistedPrefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

interface PrefsState extends PersistedPrefs {
  setShowSubagentThinking: (v: boolean) => void;
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...load(),
  setShowSubagentThinking: (v) => {
    set({ showSubagentThinking: v });
    const { showSubagentThinking } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ showSubagentThinking }));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  },
}));
