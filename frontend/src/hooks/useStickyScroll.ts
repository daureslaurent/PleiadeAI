import { useCallback, useEffect, useRef } from 'react';

/**
 * Keeps a scroll container pinned to the bottom as new content streams in, but backs off the
 * moment the user scrolls away from the bottom, and resumes once they scroll back down
 * themselves. Attach `onScroll` to the scrollable element and pass the same element via `ref`.
 */
export function useStickyScroll<T extends HTMLElement>(
  deps: unknown[],
  options: { enabled?: boolean; behavior?: ScrollBehavior; threshold?: number } = {},
) {
  const { enabled = true, behavior = 'auto', threshold = 24 } = options;
  const ref = useRef<T>(null);
  const stickyRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, [threshold]);

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (el && stickyRef.current) el.scrollTo({ top: el.scrollHeight, behavior });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, onScroll };
}
