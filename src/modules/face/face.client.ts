import { z } from 'zod';
import type { Config } from '../../config/env.js';
import { fail, ApiError } from '../../shared/errors/api-error.js';
import { hash } from '../../shared/security/crypto.js';
import { facePolicy, validateObservation } from './face.policy.js';
import type { FaceEngine, FaceObservation } from './face.types.js';
const observationSchema = z
  .object({
    embedding: z.array(z.number().finite()).length(512),
    model_version: z.string().min(1),
    quality_score: z.number().min(0).max(1),
    liveness_score: z.number().min(0).max(1),
    image_sha256: z.string(),
    nonce: z.string(),
  })
  .strict();

export class HttpFaceEngine implements FaceEngine {
  private inflight = 0;
  constructor(private config: Config) {}

  async ready() {
    try {
      facePolicy(this.config);
      const result = await fetch(new URL('/ready', this.config.FACE_WORKER_URL), {
        signal: AbortSignal.timeout(2000),
        headers: { authorization: `Bearer ${this.config.FACE_WORKER_TOKEN}` },
      });
      return result.ok;
    } catch {
      return false;
    }
  }

  async observe(image: Buffer, nonce: string): Promise<FaceObservation> {
    facePolicy(this.config);
    if (this.inflight >= 4) fail(503, 'FACE_BUSY', 'Verifikasi wajah sedang penuh. Coba lagi.');
    this.inflight++;
    try {
      const form = new FormData();
      form.set('image', new Blob([new Uint8Array(image)]), 'capture.jpg');
      form.set('nonce', nonce);
      const result = await fetch(new URL('/v1/observe', this.config.FACE_WORKER_URL), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.FACE_WORKER_TOKEN}` },
        body: form,
        signal: AbortSignal.timeout(10000),
      });
      if (!result.ok) {
        if (result.status === 422) {
          fail(422, 'FACE_QUALITY_LOW', 'Wajah tidak tunggal atau kualitas gambar tidak memadai.');
        }
        fail(503, 'FACE_SERVICE_UNAVAILABLE', 'Layanan verifikasi wajah belum tersedia.');
      }
      const reader = result.body?.getReader();
      if (!reader) fail(503, 'FACE_RESPONSE_INVALID', 'Respons worker tidak valid.');
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 65536) {
          await reader.cancel();
          fail(503, 'FACE_RESPONSE_INVALID', 'Respons worker terlalu besar.');
        }
        chunks.push(chunk.value);
      }
      const parsed = observationSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (parsed.image_sha256 !== hash(image) || parsed.nonce !== nonce) {
        fail(503, 'FACE_RESPONSE_INVALID', 'Bukti worker tidak cocok dengan permintaan.');
      }
      validateObservation(parsed, this.config);
      return parsed;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return fail(503, 'FACE_SERVICE_UNAVAILABLE', 'Layanan verifikasi wajah gagal merespons.');
    } finally {
      this.inflight--;
    }
  }
}
