import { Router, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { authMiddleware, roles } from '../auth/auth.middleware.js';
import { OidcProvider, type SsoProvider } from './sso.service.js';
import { createSsoController } from './sso.controller.js';
import { createGoogleController } from './google.controller.js';
import { GoogleOidcProvider, type GoogleProvider } from './google.service.js';

export function ssoRoutes(
  pool: Pool,
  config: Config,
  limiter: RequestHandler,
  provider: SsoProvider = new OidcProvider(config),
  google: GoogleProvider = new GoogleOidcProvider(config),
) {
  const router = Router();
  const controller = createSsoController(pool, config, provider);
  const googleController = createGoogleController(pool, config, google);
  router.post('/auth/google/challenge', limiter, googleController.challenge);
  router.post('/auth/google', limiter, googleController.login);
  router.post('/auth/web/google/start', limiter, googleController.start);
  router.get('/auth/web/google/callback', limiter, googleController.callback);

  router.get('/auth/methods', controller.getMethods);
  router.post('/auth/sso/start', limiter, controller.start);
  router.post('/auth/sso/exchange', limiter, controller.exchange);

  router.use('/admin/sso', authMiddleware(pool, config), roles('SUPER_ADMIN'));
  router.post('/admin/sso/identities', controller.linkIdentity);
  router.get('/admin/sso/identities', controller.listIdentities);
  router.delete('/admin/sso/identities/:id', controller.unlinkIdentity);

  return router;
}
