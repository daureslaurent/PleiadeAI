import type { Express, NextFunction, Request, Response, Router } from 'express';
import { createLogger } from '../../../config/logger';

const log = createLogger('http-errors');

/**
 * Express 4 does not catch a rejected promise from an `async` handler.
 *
 * Every route in this app is `async (req, res) => …`, so a throw anywhere in one — a Mongoose
 * `ValidationError` on a bad body, a `CastError` on a mistyped field — rejects silently. The handler
 * never answers, the request hangs, and the caller eventually gets a **502 from Caddy with no
 * message at all**. That is survivable when the only client is our own UI, which sends
 * well-formed bodies; it is not survivable now that the same routes are driven by an MCP client, the
 * CLI and agents, where a slightly wrong field is the normal case and the error text is the whole
 * diagnostic.
 *
 * `installAsyncErrorHandling` walks the mounted router tree once at boot and wraps each handler so a
 * rejection becomes `next(err)`, then registers the terminal handler that turns it into a real
 * status code. Doing it at the app level rather than per-route means a new route cannot forget.
 */
export function installAsyncErrorHandling(app: Express): void {
  const router = (app as unknown as { _router?: Router & { stack?: unknown[] } })._router;
  if (!router?.stack) {
    log.warn('could not reach the express router stack — async errors stay uncaught');
    return;
  }
  const wrapped = wrapStack(router.stack);
  log.info({ handlers: wrapped }, 'async error handling installed');
  app.use(terminalErrorHandler);
}

interface Layer {
  handle?: unknown;
  route?: { stack?: Layer[] };
  name?: string;
}

/** Recursively wrap every non-error handler in a layer stack. Returns how many were wrapped. */
function wrapStack(stack: unknown[]): number {
  let count = 0;
  for (const entry of stack as Layer[]) {
    if (entry.route?.stack) {
      count += wrapStack(entry.route.stack);
      continue;
    }
    const handle = entry.handle;
    if (typeof handle !== 'function') continue;

    // A nested router is itself a function carrying its own stack — descend instead of wrapping.
    const nested = (handle as unknown as { stack?: unknown[] }).stack;
    if (Array.isArray(nested)) {
      count += wrapStack(nested);
      continue;
    }
    // Arity 4 is an error handler; wrapping it would change its signature and take it out of the
    // error chain entirely.
    if (handle.length >= 4) continue;
    if ((handle as { __asyncWrapped?: boolean }).__asyncWrapped) continue;

    const original = handle as (req: Request, res: Response, next: NextFunction) => unknown;
    const wrapper = function (this: unknown, req: Request, res: Response, next: NextFunction) {
      let result: unknown;
      try {
        result = original.call(this, req, res, next);
      } catch (err) {
        next(err);
        return;
      }
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(next);
      }
      return result;
    };
    // Express reads `fn.length` to decide what a layer *is*, so the wrapper must keep the original's
    // arity or a 3-arg middleware starts being treated as a 2-arg route handler.
    Object.defineProperty(wrapper, 'length', { value: original.length });
    Object.defineProperty(wrapper, 'name', { value: original.name });
    (wrapper as { __asyncWrapped?: boolean }).__asyncWrapped = true;
    entry.handle = wrapper;
    count += 1;
  }
  return count;
}

/**
 * Turn a thrown error into a status the caller can act on. Mongoose's validation and cast errors are
 * the operator's mistake, not ours — they answer 400 with the field that was wrong, because "422:
 * color must be a number" is a fix and "502" is a mystery.
 */
function terminalErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const e = err as { name?: string; message?: string; code?: number; errors?: Record<string, { message?: string }> };

  if (e?.name === 'ValidationError' || e?.name === 'CastError') {
    const detail = e.errors
      ? Object.entries(e.errors)
          .map(([field, v]) => `${field}: ${v?.message ?? 'invalid'}`)
          .join('; ')
      : (e.message ?? 'invalid request body');
    log.warn({ path: req.originalUrl, detail }, 'rejected an invalid request body');
    if (!res.headersSent) res.status(400).json({ error: detail });
    return;
  }

  if (e?.code === 11000) {
    log.warn({ path: req.originalUrl }, 'rejected a duplicate');
    if (!res.headersSent) res.status(409).json({ error: 'already exists', detail: e.message });
    return;
  }

  log.error({ path: req.originalUrl, err: e?.message ?? String(err) }, 'unhandled route error');
  if (!res.headersSent) res.status(500).json({ error: e?.message ?? 'internal error' });
}
