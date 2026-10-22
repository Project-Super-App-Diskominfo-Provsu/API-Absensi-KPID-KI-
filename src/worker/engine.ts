import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { hash } from '../shared/security/crypto.js';
import {
  alignFace,
  miniFasNetCrop,
  nchw,
  nms,
  sharpness,
  softmax,
  type Detection,
} from './math.js';
const asset = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    license_reference: z.string().min(1),
  })
  .strict();
const triplet = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const manifestSchema = z
  .object({
    model_version: z.string().min(1),
    usage: z.enum(['RESEARCH_ONLY', 'OPERATIONAL']).optional(),
    detector: asset.extend({
      size: z.literal(640),
      score_threshold: z.number().positive().max(1),
      nms_threshold: z.number().positive().max(1),
      score_outputs: z.tuple([z.string(), z.string(), z.string()]),
      box_outputs: z.tuple([z.string(), z.string(), z.string()]),
      landmark_outputs: z.tuple([z.string(), z.string(), z.string()]),
    }),
    recognizer: asset.extend({
      output: z.string().min(1),
      mean: triplet,
      divisor: triplet.refine((v) => v.every((n) => n > 0)),
      color: z.enum(['RGB', 'BGR']),
    }),
    pad: asset.extend({
      output: z.string().min(1),
      width: z.number().int().min(16).max(512),
      height: z.number().int().min(16).max(512),
      mean: triplet,
      divisor: triplet.refine((v) => v.every((n) => n > 0)),
      color: z.enum(['RGB', 'BGR']),
      crop_scale: z.number().min(1).max(4),
      crop_mode: z.enum(['CLIP', 'MINIFASNET']).default('CLIP'),
      live_class: z.number().int().min(0).max(10),
      output_mode: z.enum(['LOGITS', 'PROBABILITIES']),
    }),
    quality: z
      .object({
        min_face_pixels: z.number().positive(),
        sharpness_reference: z.number().positive(),
      })
      .strict(),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
export class ModelInputError extends Error {}
export class OnnxFaceEngine {
  private constructor(
    private manifest: Manifest,
    private detector: ort.InferenceSession,
    private recognizer: ort.InferenceSession,
    private pad: ort.InferenceSession,
  ) {}
  static async load(
    path: string,
    options: { allowResearch?: boolean } = {},
  ): Promise<OnnxFaceEngine> {
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (manifest.usage === 'RESEARCH_ONLY' && !options.allowResearch)
      throw new Error('Research-only face models are disabled in this environment');
    const base = dirname(resolve(path));
    const sessions: ort.InferenceSession[] = [];
    try {
      for (const asset of [manifest.detector, manifest.recognizer, manifest.pad]) {
        const bytes = await readFile(resolve(base, asset.path));
        if (hash(bytes) !== asset.sha256) throw new Error('Model checksum mismatch');
        sessions.push(
          await ort.InferenceSession.create(bytes, {
            executionProviders: ['cpu'],
            intraOpNumThreads: 2,
            interOpNumThreads: 1,
            graphOptimizationLevel: 'all',
          }),
        );
      }
      const [detector, recognizer, pad] = sessions as [
        ort.InferenceSession,
        ort.InferenceSession,
        ort.InferenceSession,
      ];
      if ([detector, recognizer, pad].some((s) => s.inputNames.length !== 1))
        throw new Error('Each model must expose one NCHW image input');
      for (const name of [
        ...manifest.detector.score_outputs,
        ...manifest.detector.box_outputs,
        ...manifest.detector.landmark_outputs,
      ])
        if (!detector.outputNames.includes(name)) throw new Error('SCRFD output name missing');
      if (
        !recognizer.outputNames.includes(manifest.recognizer.output) ||
        !pad.outputNames.includes(manifest.pad.output)
      )
        throw new Error('Model output name missing');
      const result = new OnnxFaceEngine(manifest, detector, recognizer, pad);
      // Validate tensor contracts during startup, before advertising readiness.
      const detection = await result.run(
        detector,
        Buffer.alloc(640 * 640 * 3),
        640,
        640,
        [127.5, 127.5, 127.5],
        [128, 128, 128],
        'RGB',
      );
      for (let level = 0; level < 3; level++) {
        const count = (640 / [8, 16, 32][level]!) ** 2 * 2;
        if (
          detection[manifest.detector.score_outputs[level]!]?.data.length !== count ||
          detection[manifest.detector.box_outputs[level]!]?.data.length !== count * 4 ||
          detection[manifest.detector.landmark_outputs[level]!]?.data.length !== count * 10
        )
          throw new Error('Unsupported SCRFD tensor shapes');
      }
      const recognition = await result.run(
        recognizer,
        Buffer.alloc(112 * 112 * 3),
        112,
        112,
        manifest.recognizer.mean,
        manifest.recognizer.divisor,
        manifest.recognizer.color,
      );
      if (recognition[manifest.recognizer.output]?.data.length !== 512)
        throw new Error('ArcFace output must contain 512 numbers');
      const padOutput = await result.run(
        pad,
        Buffer.alloc(manifest.pad.width * manifest.pad.height * 3),
        manifest.pad.width,
        manifest.pad.height,
        manifest.pad.mean,
        manifest.pad.divisor,
        manifest.pad.color,
      );
      if ((padOutput[manifest.pad.output]?.data.length ?? 0) <= manifest.pad.live_class)
        throw new Error('PAD live class not found');
      return result;
    } catch (error) {
      await Promise.allSettled(sessions.map((session) => session.release()));
      throw error;
    }
  }
  async close() {
    await Promise.all([this.detector.release(), this.recognizer.release(), this.pad.release()]);
  }
  private async run(
    session: ort.InferenceSession,
    pixels: Buffer,
    width: number,
    height: number,
    mean: number[],
    divisor: number[],
    color: 'RGB' | 'BGR',
  ) {
    const tensor = new ort.Tensor('float32', nchw(pixels, width, height, mean, divisor, color), [
      1,
      3,
      height,
      width,
    ]);
    return session.run({ [session.inputNames[0]!]: tensor });
  }
  private async detect(rgb: Buffer, width: number, height: number): Promise<Detection[]> {
    const size = 640,
      scale = Math.min(size / width, size / height),
      w = Math.floor(width * scale),
      h = Math.floor(height * scale);
    const resized = await sharp(rgb, { raw: { width, height, channels: 3 } })
      .resize(w, h, { fit: 'fill' })
      .extend({ top: 0, left: 0, bottom: size - h, right: size - w, background: '#000000' })
      .raw()
      .toBuffer();
    const outputs = await this.run(
      this.detector,
      resized,
      size,
      size,
      [127.5, 127.5, 127.5],
      [128, 128, 128],
      'RGB',
    );
    const detections: Detection[] = [];
    for (let level = 0; level < 3; level++) {
      const stride = [8, 16, 32][level]!,
        columns = size / stride,
        count = columns * columns * 2;
      const scores = outputs[this.manifest.detector.score_outputs[level]!]!.data;
      const boxes = outputs[this.manifest.detector.box_outputs[level]!]!.data;
      const points = outputs[this.manifest.detector.landmark_outputs[level]!]!.data;
      if (scores.length !== count || boxes.length !== count * 4 || points.length !== count * 10)
        throw new Error('Unsupported SCRFD tensor shapes');
      for (let i = 0; i < count; i++) {
        const score = Number(scores[i]);
        if (score < this.manifest.detector.score_threshold) continue;
        const anchor = Math.floor(i / 2),
          x = (anchor % columns) * stride,
          y = Math.floor(anchor / columns) * stride;
        const box: [number, number, number, number] = [
          (x - Number(boxes[i * 4]) * stride) / scale,
          (y - Number(boxes[i * 4 + 1]) * stride) / scale,
          (x + Number(boxes[i * 4 + 2]) * stride) / scale,
          (y + Number(boxes[i * 4 + 3]) * stride) / scale,
        ];
        const landmarks = Array.from(
          { length: 10 },
          (_, j) => ((j % 2 === 0 ? x : y) + Number(points[i * 10 + j]) * stride) / scale,
        );
        if ([score, ...box, ...landmarks].every(Number.isFinite))
          detections.push({ score, box, landmarks });
      }
    }
    return nms(detections, this.manifest.detector.nms_threshold);
  }
  async observe(bytes: Buffer, nonce: string) {
    const image = await sharp(bytes, { limitInputPixels: 16_000_000 })
      .rotate()
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = image.info;
    const faces = await this.detect(image.data, width, height);
    if (faces.length !== 1) throw new ModelInputError('Exactly one face required');
    const face = faces[0]!,
      faceSize = Math.min(face.box[2] - face.box[0], face.box[3] - face.box[1]);
    if (faceSize <= 0) throw new ModelInputError('Invalid face bounds');
    const aligned = alignFace(image.data, width, height, face.landmarks),
      recognizer = this.manifest.recognizer;
    const recognition = await this.run(
      this.recognizer,
      aligned,
      112,
      112,
      recognizer.mean,
      recognizer.divisor,
      recognizer.color,
    );
    const embedding = Array.from(recognition[recognizer.output]!.data, Number);
    const length = Math.hypot(...embedding);
    if (embedding.length !== 512 || !Number.isFinite(length) || length < 1e-8)
      throw new Error('Invalid face embedding');
    const pad = this.manifest.pad,
      cx = (face.box[0] + face.box[2]) / 2,
      cy = (face.box[1] + face.box[3]) / 2;
    const halfW = ((face.box[2] - face.box[0]) * pad.crop_scale) / 2,
      halfH = ((face.box[3] - face.box[1]) * pad.crop_scale) / 2;
    const crop =
      pad.crop_mode === 'MINIFASNET'
        ? miniFasNetCrop(width, height, face.box, pad.crop_scale)
        : {
            left: Math.max(0, Math.floor(cx - halfW)),
            top: Math.max(0, Math.floor(cy - halfH)),
            right: Math.min(width, Math.ceil(cx + halfW)),
            bottom: Math.min(height, Math.ceil(cy + halfH)),
          };
    const { left, top, right, bottom } = crop;
    if (right <= left || bottom <= top) throw new ModelInputError('Face crop outside image');
    const cropped = await sharp(image.data, { raw: { width, height, channels: 3 } })
      .extract({ left, top, width: right - left, height: bottom - top })
      .resize(pad.width, pad.height, {
        fit: 'fill',
        kernel: pad.crop_mode === 'MINIFASNET' ? 'linear' : 'lanczos3',
      })
      .raw()
      .toBuffer();
    const padResult = await this.run(
      this.pad,
      cropped,
      pad.width,
      pad.height,
      pad.mean,
      pad.divisor,
      pad.color,
    );
    const values = Array.from(padResult[pad.output]!.data, Number),
      probabilities = pad.output_mode === 'LOGITS' ? softmax(values) : values;
    if (
      probabilities.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
      Math.abs(probabilities.reduce((s, v) => s + v, 0) - 1) > 0.01
    )
      throw new Error('Invalid PAD probabilities');
    const liveness = probabilities[pad.live_class];
    if (liveness === undefined) throw new Error('PAD live class not found');
    const quality = Math.min(
      1,
      faceSize / this.manifest.quality.min_face_pixels,
      sharpness(aligned, 112, 112) / this.manifest.quality.sharpness_reference,
    );
    return {
      embedding: embedding.map((v) => v / length),
      model_version: this.manifest.model_version,
      quality_score: quality,
      liveness_score: liveness,
      image_sha256: hash(bytes),
      nonce,
    };
  }
}
