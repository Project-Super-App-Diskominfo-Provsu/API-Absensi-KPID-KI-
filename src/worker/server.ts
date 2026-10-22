import express from 'express';
import helmet from 'helmet';
import { timingSafeEqual } from 'node:crypto';
import { pino } from 'pino';
import { z } from 'zod';
import { upload, validateImage } from '../shared/files/image-upload.js';
import { hash } from '../shared/security/crypto.js';
import { OnnxFaceEngine, ModelInputError } from './engine.js';
import { researchModelsAllowed } from './config.js';
const logger = pino();
const allowResearch = researchModelsAllowed();
if (allowResearch && process.env.NODE_ENV === 'production')
  logger.warn(
    'Research models explicitly enabled for evaluation; not approved for operational attendance',
  );
const token = z.string().min(32).parse(process.env.FACE_WORKER_TOKEN);
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .default(8000)
  .parse(process.env.FACE_WORKER_PORT);
let engine: OnnxFaceEngine | undefined;
if (process.env.FACE_MANIFEST_PATH) {
  try {
    engine = await OnnxFaceEngine.load(process.env.FACE_MANIFEST_PATH, {
      allowResearch,
    });
    logger.info('Face models loaded');
  } catch (error) {
    logger.error(
      { error_type: error?.constructor?.name },
      'Model loading failed; worker remains unavailable',
    );
  }
}
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use((req, res, next) => {
  const candidate = req.get('authorization') ?? '';
  if (!timingSafeEqual(Buffer.from(hash(candidate)), Buffer.from(hash(`Bearer ${token}`)))) {
    res.status(401).json({ error: 'UNAUTHENTICATED' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  next();
});
app.get('/ready', (_req, res) => res.status(engine ? 200 : 503).json({ ready: Boolean(engine) }));
let busy = false;
app.post('/v1/observe', upload.single('image'), async (req, res) => {
  if (!engine) {
    res.status(503).json({ error: 'MODELS_NOT_CONFIGURED' });
    return;
  }
  if (busy) {
    res.status(503).json({ error: 'WORKER_BUSY' });
    return;
  }
  busy = true;
  try {
    const { nonce } = z
      .object({ nonce: z.string().min(40).max(100) })
      .strict()
      .parse(req.body);
    const image = await validateImage(req.file);
    res.json(await engine.observe(image, nonce));
  } finally {
    busy = false;
  }
});
app.use(
  (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const inputError =
      error instanceof ModelInputError ||
      error instanceof z.ZodError ||
      (error as { status?: number })?.status === 400;
    res
      .status(inputError ? 422 : 503)
      .json({ error: inputError ? 'FACE_INPUT_INVALID' : 'INFERENCE_UNAVAILABLE' });
  },
);
const server = app.listen(port, () => logger.info({ port }, 'Face worker started'));
server.requestTimeout = 15000;
server.headersTimeout = 10000;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15000).unref();
  });
