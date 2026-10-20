import type { Config } from '../../config/env.js';
import { fail } from '../../shared/errors/api-error.js';
import type { FaceObservation } from './face.types.js';
export function facePolicy(config: Config) {
  const {
    FACE_MATCH_THRESHOLD: match,
    FACE_REVIEW_THRESHOLD: review,
    FACE_LIVENESS_THRESHOLD: liveness,
    FACE_QUALITY_THRESHOLD: quality,
  } = config;
  if (
    match === undefined ||
    review === undefined ||
    liveness === undefined ||
    quality === undefined ||
    !config.FACE_MODEL_VERSION ||
    config.FACE_WORKER_TOKEN.length < 32
  ) {
    fail(503, 'FACE_NOT_CONFIGURED', 'Model, kredensial, dan threshold wajah belum dikonfigurasi.');
  }
  return { match, review, liveness, quality, model_version: config.FACE_MODEL_VERSION };
}

export function normalize(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length < 1e-10) {
    fail(503, 'FACE_RESPONSE_INVALID', 'Embedding wajah tidak valid.');
  }
  return vector.map((v) => v / length);
}

export function similarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    fail(409, 'FACE_REENROLL_REQUIRED', 'Model wajah berubah. Daftarkan wajah ulang.');
  }
  const x = normalize(a),
    y = normalize(b);
  return Math.max(
    -1,
    Math.min(
      1,
      x.reduce((sum, v, i) => sum + v * y[i]!, 0),
    ),
  );
}

export function validateObservation(value: FaceObservation, config: Config) {
  const policy = facePolicy(config);
  if (value.model_version !== policy.model_version) {
    fail(409, 'FACE_MODEL_MISMATCH', 'Versi model worker tidak sesuai konfigurasi.');
  }
  normalize(value.embedding);
  if (value.quality_score < policy.quality) {
    fail(422, 'FACE_QUALITY_LOW', 'Kualitas gambar wajah belum memadai.');
  }
  if (value.liveness_score < policy.liveness) {
    fail(422, 'LIVENESS_FAILED', 'Pemeriksaan liveness gagal.');
  }
}
