import { useEffect, useState } from 'react';

/** useState backed by localStorage, so UI preferences (e.g. panel collapse) survive reloads. */
export function usePersistentState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore write failures (e.g. private mode) */
    }
  }, [key, value]);

  return [value, setValue];
}
