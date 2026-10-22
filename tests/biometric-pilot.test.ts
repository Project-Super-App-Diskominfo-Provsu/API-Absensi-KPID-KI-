import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config/env.js';
import { facePolicy, validateObservation } from '../src/modules/face/face.policy.js';
import { researchManifest } from '../src/worker/research-models.js';

const pilot = parseEnv(
  readFileSync(new URL('../config/biometric-pilot.env', import.meta.url), 'utf8'),
);
const config = readConfig({
  DATABASE_URL: 'postgresql://test:test@localhost/db',
  REDIS_URL: 'redis://localhost',
  JWT_SECRET: 's'.repeat(40),
  BIOMETRIC_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  FACE_WORKER_TOKEN: 'w'.repeat(40),
  ...pilot,
});
const observation = {
  embedding: Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)),
  model_version: researchManifest.model_version,
  quality_score: 1,
  liveness_score: 0.9,
};

describe('explicit biometric pilot policy', () => {
  it('loads the complete policy for the pinned research model', () => {
    expect(facePolicy(config)).toEqual({
      match: 0.8,
      review: 0.7,
      liveness: 0.9,
      quality: 1,
      model_version: researchManifest.model_version,
    });
    expect(() => validateObservation(observation, config)).not.toThrow();
  });

  it.each([
    [{ liveness_score: 0.899999 }, 'LIVENESS_FAILED'],
    [{ quality_score: 0.999999 }, 'FACE_QUALITY_LOW'],
    [{ model_version: 'different-model' }, 'FACE_MODEL_MISMATCH'],
  ])('rejects an observation outside pilot requirements: %j', (change, code) => {
    expect(() => validateObservation({ ...observation, ...change }, config)).toThrow(
      expect.objectContaining({ code }),
    );
  });
});
