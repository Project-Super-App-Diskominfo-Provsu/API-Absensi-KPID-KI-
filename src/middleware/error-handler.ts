import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import type { Logger } from 'pino';
import { ApiError } from '../shared/errors/api-error.js';
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    let error = err instanceof ApiError ? err : undefined;
    if (err instanceof ZodError)
      error = new ApiError(400, 'VALIDATION_ERROR', 'Data permintaan tidak valid.');
    if (err instanceof MulterError)
      error = new ApiError(400, 'UPLOAD_INVALID', 'Ukuran atau jumlah file tidak valid.');
    if ((err as { type?: string })?.type === 'entity.parse.failed')
      error = new ApiError(400, 'VALIDATION_ERROR', 'JSON tidak valid.');
    if ((err as { type?: string })?.type === 'entity.too.large')
      error = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Permintaan terlalu besar.');
    const code = (err as { code?: string })?.code;
    if (code === '23505')
      error = new ApiError(409, 'CONFLICT', 'Data sudah terdaftar atau operasi bertabrakan.');
    if (code === '23503' || code === '23514' || code === '22P02')
      error = new ApiError(400, 'VALIDATION_ERROR', 'Relasi atau nilai data tidak valid.');
    if (!error)
      logger.error(
        {
          error_type: err?.constructor?.name,
          database_code: code,
          request_id: res.locals.requestId,
        },
        'Request failed',
      );
    res.status(error?.status ?? 500).json({
      error: {
        code: error?.code ?? 'INTERNAL_ERROR',
        message: error?.message ?? 'Terjadi kesalahan server.',
        ...(err instanceof ZodError
          ? {
              details: err.issues.map((issue) => ({
                field: issue.path.join('.'),
                message: issue.message,
              })),
            }
          : {}),
      },
      request_id: res.locals.requestId,
    });
  };
}
