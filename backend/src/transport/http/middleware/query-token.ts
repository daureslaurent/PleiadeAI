import type { NextFunction, Request, Response } from 'express';

/**
 * Accept the session JWT as a `?token=` query parameter when no `Authorization` header is present.
 *
 * A `<video src>` / `<audio src>` element fetches its own bytes and cannot be given headers — the same
 * constraint that already made the VNC relay take `?token=` (`transport/ws/visual-proxy.ts`). Fetching
 * the whole file as an authenticated blob first is the alternative, and it forfeits streaming and
 * seeking: a ten-minute video would have to download completely before it could play.
 *
 * This only *moves* a credential the client already holds into the place `requireAuth` reads, so it
 * grants nothing extra. It is deliberately mounted in front of the resources router alone rather than
 * globally, so no other surface starts accepting credentials in a URL.
 */
export function allowQueryToken(req: Request, _res: Response, next: NextFunction): void {
  if (!req.headers.authorization) {
    const token = req.query.token;
    if (typeof token === 'string' && token) req.headers.authorization = `Bearer ${token}`;
  }
  next();
}
