import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Plays an endless fMP4 flux through `MediaSource` (STREAMING_PLAN.md §5).
 *
 * The backend serves one never-ending chunked response rather than a segmented playlist, so there is
 * no manifest to poll and nothing to schedule — the whole client is a `fetch` reader pushing bytes
 * into a `SourceBuffer`. Three things that are not obvious, and are the reason this is a hook rather
 * than four lines inline:
 *
 * - **Appends must be serialised.** `appendBuffer` throws if the buffer is still updating, so chunks
 *   queue and drain on `updateend`.
 * - **A live buffer has to be evicted.** Nothing ever ends, so without trimming the trailing range a
 *   stream left open overnight accumulates hours of decoded media and the tab is eventually killed.
 * - **Drift has to be corrected.** A backgrounded tab keeps buffering but stops rendering; on return
 *   the element can be minutes behind, so it is nudged back to the live edge.
 */

/** Media kept behind the playhead. Enough to survive a stall, far short of what strains the tab. */
const KEEP_BEHIND_SEC = 60;
/** Falling further behind the live edge than this is drift, not jitter — seek forward. */
const MAX_DRIFT_SEC = 20;
/** Where "live" is: a hair behind the edge, so a seek doesn't land in an unbuffered gap. */
const LIVE_MARGIN_SEC = 1.5;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

export type LiveStatus = 'idle' | 'connecting' | 'buffering' | 'playing' | 'error';

export interface LiveStream {
  status: LiveStatus;
  error: string | null;
  /** Seconds of decoded media ahead of the playhead. */
  aheadSec: number;
  /** True while the element is behind the live edge by more than a jitter's worth. */
  behind: boolean;
  /** Jump to the live edge. */
  seekLive(): void;
  /** Drop the connection and dial back in from scratch. */
  reconnect(): void;
}

export function useLiveStream(
  media: HTMLMediaElement | null,
  url: string | null,
  mime: string | null,
  enabled: boolean,
): LiveStream {
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [aheadSec, setAheadSec] = useState(0);
  const [behind, setBehind] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const abortRef = useRef<AbortController | null>(null);

  const seekLive = useCallback(() => {
    if (!media) return;
    const { buffered } = media;
    if (buffered.length === 0) return;
    media.currentTime = Math.max(0, buffered.end(buffered.length - 1) - LIVE_MARGIN_SEC);
  }, [media]);

  const reconnect = useCallback(() => {
    abortRef.current?.abort();
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!media || !url || !mime || !enabled) return;
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mime)) {
      setStatus('error');
      setError(`this browser cannot decode ${mime}`);
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    let disposed = false;
    let retryTimer: number | undefined;

    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    media.src = objectUrl;
    setStatus('connecting');
    setError(null);

    const onSourceOpen = () => {
      if (disposed) return;
      let sourceBuffer: SourceBuffer;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mime);
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'could not open a source buffer');
        return;
      }
      sourceBuffer.mode = 'segments';

      const queue: Uint8Array[] = [];
      let appending = false;

      const drain = () => {
        if (disposed || appending || queue.length === 0) return;
        if (mediaSource.readyState !== 'open' || sourceBuffer.updating) return;
        const chunk = queue.shift();
        if (!chunk) return;
        appending = true;
        try {
          sourceBuffer.appendBuffer(chunk as BufferSource);
        } catch (err) {
          appending = false;
          // QuotaExceeded is the expected failure here: evict hard and put the chunk back rather
          // than tearing the stream down over a full buffer.
          if (err instanceof DOMException && err.name === 'QuotaExceededError') {
            queue.unshift(chunk);
            evict(true);
            return;
          }
          setStatus('error');
          setError(err instanceof Error ? err.message : 'append failed');
        }
      };

      const evict = (aggressive = false) => {
        if (disposed || sourceBuffer.updating || sourceBuffer.buffered.length === 0) return;
        const start = sourceBuffer.buffered.start(0);
        const keep = aggressive ? KEEP_BEHIND_SEC / 4 : KEEP_BEHIND_SEC;
        const cutoff = media.currentTime - keep;
        if (cutoff > start + 1) {
          try {
            sourceBuffer.remove(start, cutoff);
          } catch {
            /* a remove that races an append is retried on the next tick */
          }
        }
      };

      sourceBuffer.addEventListener('updateend', () => {
        appending = false;
        evict();
        drain();
      });

      void (async () => {
        try {
          const response = await fetch(url, { signal: abort.signal, cache: 'no-store' });
          if (!response.ok || !response.body) {
            throw new Error(response.status === 401 ? 'the stream token was rejected' : `stream returned ${response.status}`);
          }
          setStatus('buffering');
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done || disposed) break;
            if (value) {
              queue.push(value);
              drain();
            }
          }
          // The backend only ends the response when the stream is torn down; anything else is a
          // dropped connection, and both are handled the same way — dial back in.
          if (!disposed) scheduleRetry('the stream ended');
        } catch (err) {
          if (disposed || abort.signal.aborted) return;
          scheduleRetry(err instanceof Error ? err.message : 'the stream dropped');
        }
      })();
    };

    const scheduleRetry = (reason: string) => {
      setError(reason);
      setStatus('connecting');
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 4));
      retryTimer = window.setTimeout(() => setAttempt((n) => n + 1), delay);
    };

    mediaSource.addEventListener('sourceopen', onSourceOpen);

    /**
     * Land the playhead inside the buffered range, and keep it near the live edge.
     *
     * The first half of that is not optional: fragments carry the *stream's* timeline, which by the
     * time anyone tunes in is minutes past zero, so a fresh element sitting at `currentTime = 0`
     * points at a gap and stalls forever. Joining a live stream always means seeking to where the
     * media actually is.
     */
    const align = () => {
      const { buffered } = media;
      if (buffered.length === 0) return;
      const start = buffered.start(0);
      const edge = buffered.end(buffered.length - 1);
      if (media.currentTime < start) {
        media.currentTime = Math.max(start + 0.1, edge - LIVE_MARGIN_SEC);
        return;
      }
      const ahead = edge - media.currentTime;
      setAheadSec(Math.max(0, ahead));
      setBehind(ahead > MAX_DRIFT_SEC);
      if (!media.paused && ahead > MAX_DRIFT_SEC) media.currentTime = edge - LIVE_MARGIN_SEC;
      if (!media.paused && media.readyState >= 3) setStatus('playing');
    };

    // `progress` fires as soon as the first fragment is buffered, which is when the initial seek
    // has to happen; the interval then handles drift for the rest of the session.
    media.addEventListener('progress', align);
    const monitor = window.setInterval(align, 1000);

    return () => {
      disposed = true;
      media.removeEventListener('progress', align);
      window.clearInterval(monitor);
      if (retryTimer) window.clearTimeout(retryTimer);
      abort.abort();
      mediaSource.removeEventListener('sourceopen', onSourceOpen);
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch {
        /* already torn down */
      }
      URL.revokeObjectURL(objectUrl);
      media.removeAttribute('src');
      media.load();
    };
    // `attempt` is the reconnect trigger: bumping it re-runs the whole effect with a fresh
    // MediaSource, which is the only reliable way to recover a broken SourceBuffer.
  }, [media, url, mime, enabled, attempt]);

  return { status, error, aheadSec, behind, seekLive, reconnect };
}
