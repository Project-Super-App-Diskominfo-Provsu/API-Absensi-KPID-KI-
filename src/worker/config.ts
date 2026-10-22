import { z } from 'zod';

export function researchModelsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = z.enum(['true', 'false']).optional().parse(env.FACE_ALLOW_RESEARCH_MODELS);
  return override === undefined ? env.NODE_ENV !== 'production' : override === 'true';
}
