import { create } from 'zustand';

/**
 * Client-side UI preferences (display-only, persisted to localStorage — never sent to the backend).
 * Kept separate from the backend-backed inference `settings` so a view toggle needs no API/migration.
 */

const KEY = 'pleiades.prefs.v1';

interface PersistedPrefs {
  /** Show the collapsible `<think>` reasoning block for delegated sub-agents (top-level always shows). */
  showSubagentThinking: boolean;
  /**
   * How many conversations the Workspace navigator lists per agent before it hides the rest behind
   * "Show more" — and the page size each of those clicks fetches.
   */
  sessionsPerAgent: number;
}

const DEFAULTS: PersistedPrefs = {
  showSubagentThinking: true,
  sessionsPerAgent: 5,
};

/** Bounds on the page size: one is a legal (if odd) choice, 50 is where a sidebar stops being one. */
export const SESSIONS_PER_AGENT_MIN = 1;
export const SESSIONS_PER_AGENT_MAX = 50;

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
  setSessionsPerAgent: (v: number) => void;
}

export const usePrefs = create<PrefsState>((set, get) => {
  /** Write the persisted subset back — every field, so adding one never drops another. */
  const persist = () => {
    const { showSubagentThinking, sessionsPerAgent } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ showSubagentThinking, sessionsPerAgent }));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  };
  return {
    ...load(),
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
