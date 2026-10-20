import express from 'express';
import helmet from 'helmet';
import { timingSafeEqual } from 'node:crypto';
import { pino } from 'pino';
import { z } from 'zod';
import { upload, validateImage, createImageHandler } from '../shared/files/image-upload.js';
import { ApiError } from '../shared/errors/api-error.js';
import { hash } from '../shared/security/crypto.js';
import { OnnxFaceEngine, ModelInputError } from './engine.js';
const logger = pino();
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
    engine = await OnnxFaceEngine.load(process.env.FACE_MANIFEST_PATH);
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
const imageHandler = createImageHandler(1);
app.post(
  '/v1/observe',
  imageHandler(upload.single('image'), async (req, res) => {
    if (!engine) {
      res.status(503).json({ error: 'MODELS_NOT_CONFIGURED' });
      return;
    }

    const { nonce } = z
      .object({ nonce: z.string().min(40).max(100) })
      .strict()
      .parse(req.body);
    const image = await validateImage(req.file);
    res.json(await engine.observe(image, nonce));
  }),
);
app.use(
  (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent || res.destroyed) {
      _next(error);
      return;
    }
    if (error instanceof ApiError && error.code === 'FACE_BUSY') {
      res.status(503).json({ error: 'WORKER_BUSY' });
      return;
    }
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
