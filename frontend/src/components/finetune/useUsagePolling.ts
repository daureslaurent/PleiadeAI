import { useEffect, useRef, useState } from 'react';
import { finetuneServersApi, type UsageReport } from '../../lib/api';

/**
 * Poll one fine-tune server's live utilization while the component is mounted *and* the tab is
 * visible. This is deliberately view-scoped — no DB writes, no EventBus traffic — so an idle
 * browser never hammers the training box. The interval is cleared on unmount and paused on
 * `visibilitychange`; an in-flight request is dropped if it resolves after unmount.
 */
export function useUsagePolling(serverId: string, intervalMs = 3000, enabled = true) {
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [error, setError] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: number | undefined;

    const poll = async () => {
      // Skip the round-trip entirely while the tab is backgrounded.
      if (document.hidden) return;
      try {
        const next = await finetuneServersApi.usage(serverId);
        if (!mounted.current) return;
        setUsage(next);
        setError(false);
      } catch {
        if (mounted.current) setError(true);
      }
    };

    const start = () => {
      if (timer !== undefined) return;
      void poll();
      timer = window.setInterval(() => void poll(), intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = () => (document.hidden ? stop() : start());

    if (enabled) {
      start();
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      mounted.current = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [serverId, intervalMs, enabled]);

  return { usage, error };
}
