import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { fail, ApiError } from '../errors/api-error.js';
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 15, fieldSize: 4096, parts: 20 },
});

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
