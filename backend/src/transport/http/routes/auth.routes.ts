import { Router } from 'express';
import { env } from '../../../config/env';
import { signToken } from '../jwt';

/**
 * Authentication route (spec §2). Validates the single operator credential and issues a JWT.
 * A timing-safe-ish constant comparison isn't warranted for a single-user command center, but
 * credentials must be supplied via env — never hardcoded.
 */
export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (username === env.AUTH_USERNAME && password === env.AUTH_PASSWORD) {
    res.json({ token: signToken(env.AUTH_USERNAME) });
    return;
  }
  res.status(401).json({ error: 'invalid credentials' });
});
