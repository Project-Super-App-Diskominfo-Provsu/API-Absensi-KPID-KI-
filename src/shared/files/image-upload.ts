import type { Request, Response, RequestHandler } from 'express';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { fail, ApiError } from '../errors/api-error.js';
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 15, fieldSize: 4096, parts: 20 },
});

// Admission covers parsing and the entire async operation, including work that
// continues after a client disconnects. Face and attendance routes share one gate.
export function createImageHandler(concurrency: number) {
  let active = 0;
  return (
      parser: RequestHandler,
      handle: (req: Request, res: Response) => Promise<unknown>,
    ): RequestHandler =>
    async (req, res, next) => {
      if (active >= concurrency) {
        next(new ApiError(503, 'FACE_BUSY', 'Pemrosesan gambar sedang penuh. Coba lagi.'));
        return;
      }
      active++;
      try {
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(new ApiError(400, 'UPLOAD_ABORTED', 'Upload terputus.'));
          req.once('aborted', aborted);
          if (req.aborted) {
            req.off('aborted', aborted);
            aborted();
            return;
          }
          try {
            parser(req, res, (error?: unknown) => {
              req.off('aborted', aborted);
              if (error) reject(error);
              else resolve();
            });
          } catch (error) {
            req.off('aborted', aborted);
            reject(error);
          }
        });
        if (!req.aborted && !res.destroyed) await handle(req, res);
      } catch (error) {
        next(error);
      } finally {
        active--;
      }
    };
}
export type ImageHandler = ReturnType<typeof createImageHandler>;

export async function validateImage(file: Express.Multer.File | undefined): Promise<Buffer> {
  if (!file) fail(400, 'IMAGE_REQUIRED', 'Foto wajah wajib disertakan.');
  const type = await fileTypeFromBuffer(file.buffer);
  if (!type || !['image/jpeg', 'image/png'].includes(type.mime)) {
    fail(400, 'IMAGE_TYPE_INVALID', 'Gunakan foto JPEG atau PNG.');
  }
  try {
    const metadata = await sharp(file.buffer, { limitInputPixels: 16_000_000 }).metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width < 112 ||
      metadata.height < 112 ||
      metadata.width > 4096 ||
      metadata.height > 4096 ||
      (metadata.pages ?? 1) > 1
    ) {
      fail(400, 'IMAGE_DIMENSIONS_INVALID', 'Dimensi foto harus 112–4096 piksel dan satu frame.');
    }
    await sharp(file.buffer, { limitInputPixels: 16_000_000 }).stats();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, 'IMAGE_INVALID', 'Foto tidak dapat dibaca.');
  }
  return file.buffer;
}
