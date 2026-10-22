import type { Request, Response } from 'express';
import type { Config } from '../../config/env.js';
import { fail } from '../../shared/errors/api-error.js';
import { webCsrfToken, verifyWebCsrf } from './auth.web.service.js';

export const WEB_REFRESH_COOKIE = 'absensi_web_refresh';
export const GOOGLE_FLOW_COOKIE = 'absensi_google_flow';

export function requireWeb(config: Config) {
  if (config.WEB_AUTH_ENABLED !== 'true')
    fail(503, 'WEB_AUTH_DISABLED', 'Login panel belum diaktifkan.');
}

export function checkWebOrigin(req: Request, config: Config) {
  requireWeb(config);
  if (req.get('origin') !== config.ADMIN_WEB_ORIGIN)
    fail(403, 'ORIGIN_NOT_ALLOWED', 'Origin panel tidak diizinkan.');
}

export function readCookie(req: Request, name: string): string | undefined {
  const matches = (req.get('cookie') ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(name + '='));
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

export function webRefresh(req: Request, config: Config, csrf = true): string {
  checkWebOrigin(req, config);
  const refresh = readCookie(req, WEB_REFRESH_COOKIE);
  if (!refresh) fail(401, 'REFRESH_INVALID', 'Sesi web tidak tersedia.');
  if (csrf) verifyWebCsrf(config, refresh, req.get('x-csrf-token'));
  return refresh;
}

export function setWebRefresh(res: Response, config: Config, refresh: string) {
  res.cookie(WEB_REFRESH_COOKIE, refresh, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth/web',
    maxAge: 8 * 3600000,
  });
}

export function clearWebRefresh(res: Response, config: Config) {
  res.clearCookie(WEB_REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth/web',
  });
}

export function sendWebSession(
  res: Response,
  config: Config,
  session: { access_token: string; refresh_token: string; token_type: string; expires_in: number },
) {
  setWebRefresh(res, config, session.refresh_token);
  res.json({
    data: {
      access_token: session.access_token,
      token_type: session.token_type,
      expires_in: session.expires_in,
      csrf_token: webCsrfToken(config, session.refresh_token),
    },
  });
}
