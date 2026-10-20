import { afterEach, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config/env.js';
import { HttpFaceEngine } from '../src/modules/face/face.client.js';
const config = readConfig({
  DATABASE_URL: 'postgresql://test:test@localhost/test',
  REDIS_URL: 'redis://localhost',
  JWT_SECRET: 's'.repeat(40),
  BIOMETRIC_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  FACE_WORKER_TOKEN: 'w'.repeat(40),
  FACE_MODEL_VERSION: 'test',
  FACE_MATCH_THRESHOLD: '0.8',
  FACE_REVIEW_THRESHOLD: '0.6',
  FACE_LIVENESS_THRESHOLD: '0.9',
  FACE_QUALITY_THRESHOLD: '0.7',
});
afterEach(() => vi.unstubAllGlobals());

it('closes readiness response bodies so health probes do not retain worker connections', async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 200 })),
  );
  expect(await new HttpFaceEngine(config).ready()).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each([
  [422, 'FACE_QUALITY_LOW'],
  [503, 'FACE_SERVICE_UNAVAILABLE'],
])('closes rejected worker response bodies for HTTP %s', async (status, code) => {
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: Number(status) })),
  );
  await expect(
    new HttpFaceEngine(config).observe(Buffer.from('fixture'), 'nonce'),
  ).rejects.toMatchObject({ code });
  expect(cancel).toHaveBeenCalledOnce();
});
