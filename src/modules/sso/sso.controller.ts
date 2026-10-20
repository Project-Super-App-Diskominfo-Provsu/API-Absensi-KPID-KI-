import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { currentUser } from '../auth/auth.middleware.js';
import {
  getAuthMethods,
  startSsoLoginFlow,
  exchangeSsoCode,
  linkSsoIdentity,
  listSsoIdentities,
  unlinkSsoIdentity,
  type SsoProvider,
} from './sso.service.js';

import {
  ssoStartSchema,
  ssoExchangeSchema,
  linkSsoIdentitySchema,
  listSsoIdentitiesQuerySchema,
  unlinkSsoIdentitySchema,
} from './sso.schema.js';

export function createSsoController(pool: Pool, config: Config, provider: SsoProvider) {
  return {
    getMethods(_req: Request, res: Response) {
      res.json({ data: getAuthMethods(config) });
    },

    async start(req: Request, res: Response) {
      const input = ssoStartSchema.parse(req.body);
      const data = await startSsoLoginFlow(pool, config, provider, input.code_challenge);
      res.status(201).json({ data });
    },

    async exchange(req: Request, res: Response) {
      const input = ssoExchangeSchema.parse(req.body);
      const data = await exchangeSsoCode(pool, config, provider, input);
      res.json({ data });
    },

    async linkIdentity(req: Request, res: Response) {
      const input = linkSsoIdentitySchema.parse(req.body);
      const actor = currentUser(req);
      const data = await linkSsoIdentity(pool, config, actor, input);
      res.status(201).json({ data });
    },

    async listIdentities(req: Request, res: Response) {
      const { user_id } = listSsoIdentitiesQuerySchema.parse(req.query);
      const data = await listSsoIdentities(pool, user_id);
      res.json({ data });
    },

    async unlinkIdentity(req: Request, res: Response) {
      const id = z.uuid().parse(req.params.id);
      const { reason } = unlinkSsoIdentitySchema.parse(req.body);
      const actor = currentUser(req);
      await unlinkSsoIdentity(pool, actor, id, reason);
      res.status(204).end();
    },
  };
}
