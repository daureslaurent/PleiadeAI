import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  endpointsApi,
  finetuneServersApi,
  settingsApi,
  type Endpoint,
  type FinetuneServer,
  type InferenceSettings,
} from '../../lib/api';

/**
 * Shared state for the whole /settings section (DIRECT_ART §4 — one lane, one source of truth).
 *
 * The settings doc, the endpoint list and the fine-tune server list are loaded **once** by
 * `SettingsProvider` (mounted on the `/settings` layout route) and shared by every category page,
 * so navigating between cards never re-fetches.
 *
 * There is no Save button: `PUT /settings` is a true partial patch (only the keys present in the
 * body are written), so each field persists itself. Two verbs:
 *
 * - `edit`   — local only. What a text/number field does on every keystroke.
 * - `commit` — local + persist. Toggles/selects call it on change; text fields on blur; sliders on
 *   change (coalesced by the 400ms debounce below into one PUT per gesture).
 *
 * Writes are accumulated into one pending patch and flushed on a trailing debounce, so dragging a
 * slider or typing fast produces a single request. The pending patch is also flushed on unmount —
 * leaving Settings mid-debounce must not lose the edit.
 */

const DEBOUNCE_MS = 400;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface SettingsContextValue {
  form: InferenceSettings;
  edit: (patch: Partial<InferenceSettings>) => void;
  commit: (patch: Partial<InferenceSettings>) => void;
  save: SaveState;
  endpoints: Endpoint[];
  reloadEndpoints: () => Promise<void>;
  finetuneServers: FinetuneServer[];
  reloadFinetuneServers: () => Promise<void>;
}

const Ctx = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useSettings must be used inside <SettingsProvider>');
  return value;
}

export function SettingsProvider({
  children,
  fallback,
}: {
  children: ReactNode;
  /** Rendered until the settings doc has loaded — panels may assume `form` is non-null. */
  fallback: ReactNode;
}) {
  const [form, setForm] = useState<InferenceSettings | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [finetuneServers, setFinetuneServers] = useState<FinetuneServer[]>([]);
  const [save, setSave] = useState<SaveState>('idle');

  /** Keys edited but not yet PUT. Held in a ref so the debounce timer always flushes the latest. */
  const pending = useRef<Partial<InferenceSettings>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Clears the "Saved" pill a couple of seconds after the last write settles. */
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reloadEndpoints = useCallback(() => endpointsApi.list().then(setEndpoints), []);
  const reloadFinetuneServers = useCallback(() => finetuneServersApi.list().then(setFinetuneServers), []);

  useEffect(() => {
    void settingsApi.get().then(setForm);
    void reloadEndpoints();
    void reloadFinetuneServers();
  }, [reloadEndpoints, reloadFinetuneServers]);

  const flush = useCallback(async () => {
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    setSave('saving');
    try {
      // The response is the full persisted doc (with the server's own coercions applied, e.g. the
      // ≥32 floor on title_max_tokens) — adopt it, minus anything typed since this flush started.
      const saved = await settingsApi.update(patch);
      setForm({ ...saved, ...pending.current });
      setSave('saved');
      if (settle.current) clearTimeout(settle.current);
      settle.current = setTimeout(() => setSave('idle'), 2000);
    } catch {
      setSave('error');
    }
  }, []);

  const edit = useCallback((patch: Partial<InferenceSettings>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
  }, []);

  const commit = useCallback(
    (patch: Partial<InferenceSettings>) => {
      edit(patch);
      pending.current = { ...pending.current, ...patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [edit, flush],
  );

  // Leaving Settings while a debounce is in flight must still persist the edit.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (settle.current) clearTimeout(settle.current);
      void flush();
    },
    [flush],
  );

  if (!form) return <>{fallback}</>;

  return (
    <Ctx.Provider
      value={{ form, edit, commit, save, endpoints, reloadEndpoints, finetuneServers, reloadFinetuneServers }}
    >
      {children}
    </Ctx.Provider>
  );
}
