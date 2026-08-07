import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../../config/logger';
import { flowRepository } from '../../../domain/flows/flow.repository';
import { flowTimerScheduler } from '../../../flows/TimerScheduler';
import { streamRegistry } from '../../../streaming/StreamRegistry';
import { mintStreamToken, STREAM_TOKEN_TTL_SECONDS, verifyStreamToken } from '../../../streaming/token';

const log = createLogger('streams.routes');

/**
 * The playback surface — mounted **without** `requireAuth` (STREAMING_PLAN.md §3).
 *
 * A `<video src>` cannot send an `Authorization` header, so this one route authenticates on a signed
 * `?t=` token minted by the authed API instead. Kept in its own router so the header-authenticated
 * routes below can never be reached with a query parameter.
 */
export const streamsPlaybackRouter = Router();

streamsPlaybackRouter.get('/:flowId/live.mp4', (req: Request, res: Response) => {
  const { flowId } = req.params as { flowId: string };
  const token = typeof req.query.t === 'string' ? req.query.t : undefined;
  if (!verifyStreamToken(token, flowId)) {
    res.status(401).json({ error: 'invalid or expired stream token' });
    return;
  }

  const stream = streamRegistry.get(flowId);
  if (!stream) {
    res.status(404).json({ error: 'this flow has no live stream' });
    return;
  }

  // No Content-Length and no caching: the response is endless by construction, and every byte of it
  // is live. `flushHeaders` gets the 200 to the client before the first fragment, so the player can
  // set its MediaSource up while it waits.
  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const unsubscribe = stream.subscribe({
    write: (chunk) => {
      res.write(chunk);
    },
    close: () => res.end(),
  });

  log.info({ flowId, listeners: stream.listeners }, 'listener attached');
  const detach = () => {
    unsubscribe();
    log.info({ flowId, listeners: stream.listeners }, 'listener detached');
  };
  req.on('close', detach);
  res.on('error', detach);
});

/** Everything an operator (or an API key) drives: listing, tokens, stopping. */
export const streamsRouter = Router();

/** All live streams, for the header badge. */
streamsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ streams: streamRegistry.list() });
});

/**
 * One stream, with a freshly minted playback token and the URL to hand to a media element. The
 * token is issued here rather than on a route of its own so the player page makes exactly one call
 * before it can start decoding.
 */
streamsRouter.get('/:flowId', (req: Request, res: Response) => {
  const { flowId } = req.params as { flowId: string };
  const stream = streamRegistry.get(flowId);
  if (!stream) {
    res.status(404).json({ error: 'this flow has no live stream' });
    return;
  }
  const token = mintStreamToken(flowId);
  res.json({
    ...stream.info(),
    timerArmed: flowTimerScheduler.isArmed(flowId),
    token,
    tokenExpiresInSeconds: STREAM_TOKEN_TTL_SECONDS,
    url: `/api/streams/${flowId}/live.mp4?t=${encodeURIComponent(token)}`,
  });
});

/** Take a stream off the air and free its temp files. Also disarms the timer that was feeding it. */
streamsRouter.delete('/:flowId', async (req: Request, res: Response) => {
  const { flowId } = req.params as { flowId: string };
  await flowTimerScheduler.disarm(flowId).catch(() => undefined);
  const stopped = await streamRegistry.stop(flowId);
  if (!stopped) {
    res.status(404).json({ error: 'this flow has no live stream' });
    return;
  }
  res.json({ ok: true });
});

/**
 * Arm/disarm a flow's Time trigger without running it first.
 *
 * Lives here rather than on the flows router because arming is, in practice, "put this stream on
 * air" — and the player page needs it next to the stop button, with the same auth family.
 */
streamsRouter.post('/:flowId/timer', async (req: Request, res: Response) => {
  const { flowId } = req.params as { flowId: string };
  const armed = req.body?.armed !== false;
  const flow = await flowRepository.findById(flowId);
  if (!flow) {
    res.status(404).json({ error: 'flow not found' });
    return;
  }
  try {
    if (armed) await flowTimerScheduler.arm(flowId);
    else await flowTimerScheduler.disarm(flowId);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not change the timer' });
    return;
  }
  res.json({ ok: true, armed: flowTimerScheduler.isArmed(flowId) });
});
