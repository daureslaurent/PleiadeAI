import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env';

export interface TokenClaims {
  sub: string; // username
}

/** Issue a signed session token for the authenticated operator. */
export function signToken(username: string): string {
  const options: SignOptions = { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] };
  return jwt.sign({ sub: username } satisfies TokenClaims, env.JWT_SECRET, options);
}

/** Verify a token; throws if invalid/expired. Shared by REST middleware and the WS handshake. */
export function verifyToken(token: string): TokenClaims {
  return jwt.verify(token, env.JWT_SECRET) as TokenClaims;
}
