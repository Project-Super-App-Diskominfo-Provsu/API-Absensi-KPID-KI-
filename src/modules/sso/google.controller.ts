import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Config } from '../../config/env.js';
import {
  checkWebOrigin,
  requireWeb,
  readCookie,
  GOOGLE_FLOW_COOKIE,
  setWebRefresh,
} from '../auth/auth.web.middleware.js';
import {
  googleChallenge,
  googleMobileLogin,
  startGoogleWeb,
  completeGoogleWeb,
  type GoogleProvider,
} from './google.service.js';
import { fail } from '../../shared/errors/api-error.js';

const exchange = z
  .object({ challenge_id: z.uuid(), id_token: z.string().min(1).max(16384) })
  .strict();
const callback = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(4096),
});
export function createGoogleController(pool: Pool, config: Config, provider: GoogleProvider) {
  const flowCookie = {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/api/v1/auth/web/google',
  };
  return {
    async challenge(_req: Request, res: Response) {
      res.status(201).json({ data: await googleChallenge(pool, config) });
    },
    async login(req: Request, res: Response) {
      const input = exchange.parse(req.body);
      res.json({
        data: await googleMobileLogin(pool, config, provider, input.challenge_id, input.id_token),
      });
    },
    async start(req: Request, res: Response) {
      checkWebOrigin(req, config);
      const result = await startGoogleWeb(pool, config, provider);
      res.cookie(GOOGLE_FLOW_COOKIE, result.browser, { ...flowCookie, maxAge: 300000 });
      res.status(201).json({ data: { authorization_url: result.authorization_url } });
    },
    async callback(req: Request, res: Response) {
      requireWeb(config);
      const browser = readCookie(req, GOOGLE_FLOW_COOKIE);
      res.clearCookie(GOOGLE_FLOW_COOKIE, flowCookie);
      try {
        const input = callback.parse(req.query);
        if (!browser) fail(401, 'SSO_FLOW_INVALID', 'Browser login tidak sesuai.');
        const session = await completeGoogleWeb(
          pool,
          config,
          provider,
          input.state,
          browser,
          input.code,
        );
        setWebRefresh(res, config, session.refresh_token);
        res.redirect(303, new URL('/auth/callback', config.ADMIN_WEB_ORIGIN).href);
      } catch {
        res.redirect(303, new URL('/login?error=SSO_LOGIN_FAILED', config.ADMIN_WEB_ORIGIN).href);
      }
    },
  };
}
