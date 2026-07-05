import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type TokenClaims } from '../jwt';

/** Express request augmented with the verified operator identity. */
export interface AuthedRequest extends Request {
  user?: TokenClaims;
}

/**
 * JWT Bearer guard for all REST endpoints (spec §2). Rejects missing/invalid/expired tokens
 * with 401 before any handler runs.
 */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}
