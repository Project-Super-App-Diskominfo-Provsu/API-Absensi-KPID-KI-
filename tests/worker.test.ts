import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { hash } from '../src/shared/security/crypto.js';
import { OnnxFaceEngine } from '../src/worker/engine.js';
import { researchModelsAllowed } from '../src/worker/config.js';
import {
  arcfaceLandmarks,
  miniFasNetCrop,
  similarityTransform,
  softmax,
  nchw,
} from '../src/worker/math.js';
import { openapi } from '../src/docs/openapi.js';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3_1 } from 'openapi-types';

// Minimal protobuf encoder builds test-only constant ONNX graphs, without model downloads.
function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = value & 127;
    value = Math.floor(value / 128);
    if (value) byte |= 128;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}
const integer = (field: number, value: number) => Buffer.concat([varint(field * 8), varint(value)]);
const bytes = (field: number, value: Buffer | string) => {
  const b = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([varint(field * 8 + 2), varint(b.length), b]);
};
function valueInfo(name: string, shape: number[]) {
  const dimensions = Buffer.concat(shape.map((n) => bytes(1, integer(1, n))));
  return Buffer.concat([
    bytes(1, name),
    bytes(2, bytes(1, Buffer.concat([integer(1, 1), bytes(2, dimensions)]))),
  ]);
}
function constantModel(
  inputShape: number[],
  outputs: { name: string; shape: number[]; data: Float32Array }[],
): Buffer {
  const initializers = outputs.map((o) =>
    bytes(
      5,
      Buffer.concat([
        ...o.shape.map((n) => integer(1, n)),
        integer(2, 1),
        bytes(8, o.name),
        bytes(9, Buffer.from(o.data.buffer)),
      ]),
    ),
  );
  const graph = Buffer.concat([
    bytes(2, 'test-only-constant-model'),
    ...initializers,
    bytes(11, valueInfo('image', inputShape)),
    ...outputs.map((o) => bytes(12, valueInfo(o.name, o.shape))),
  ]);
  return Buffer.concat([
    integer(1, 8),
    bytes(2, 'absensi-test-fixture'),
    bytes(7, graph),
    bytes(8, integer(2, 13)),
  ]);
}
let folder: string, manifestPath: string;
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'absensi-onnx-test-'));
  manifestPath = join(folder, 'manifest.json');
  const outputs: { name: string; shape: number[]; data: Float32Array }[] = [];
  for (let level = 0; level < 3; level++) {
    const count = (640 / [8, 16, 32][level]!) ** 2 * 2;
    const scores = new Float32Array(count),
      boxes = new Float32Array(count * 4),
      landmarks = new Float32Array(count * 10);
    if (level === 0) {
      const index = (40 * 80 + 40) * 2;
      scores[index] = 0.99;
      boxes.fill(12, index * 4, index * 4 + 4);
      for (let i = 0; i < 10; i++)
        landmarks[index * 10 + i] = (arcfaceLandmarks[i]! * 2 + 208 - 320) / 8;
    }
    outputs.push(
      { name: `score_${level}`, shape: [count, 1], data: scores },
      { name: `box_${level}`, shape: [count, 4], data: boxes },
      { name: `landmark_${level}`, shape: [count, 10], data: landmarks },
    );
  }
  const detector = constantModel([1, 3, 640, 640], outputs);
  const feature = new Float32Array(512);
  feature[0] = 1;
  const recognizer = constantModel(
    [1, 3, 112, 112],
    [{ name: 'embedding', shape: [1, 512], data: feature }],
  );
  const pad = constantModel(
    [1, 3, 80, 80],
    [{ name: 'pad', shape: [1, 2], data: new Float32Array([0, 8]) }],
  );
  await Promise.all([
    writeFile(join(folder, 'detector.onnx'), detector),
    writeFile(join(folder, 'recognizer.onnx'), recognizer),
    writeFile(join(folder, 'pad.onnx'), pad),
  ]);
  const common = {
    license_reference:
      'Synthetic constants generated solely for automated tests; not biometric models',
  };
  await writeFile(
    manifestPath,
    JSON.stringify({
      model_version: 'test-only',
      detector: {
        ...common,
        path: 'detector.onnx',
        sha256: hash(detector),
        size: 640,
        score_threshold: 0.5,
        nms_threshold: 0.4,
        score_outputs: ['score_0', 'score_1', 'score_2'],
        box_outputs: ['box_0', 'box_1', 'box_2'],
        landmark_outputs: ['landmark_0', 'landmark_1', 'landmark_2'],
      },
      recognizer: {
        ...common,
        path: 'recognizer.onnx',
        sha256: hash(recognizer),
        output: 'embedding',
        mean: [127.5, 127.5, 127.5],
        divisor: [127.5, 127.5, 127.5],
        color: 'RGB',
      },
      pad: {
        ...common,
        path: 'pad.onnx',
        sha256: hash(pad),
        output: 'pad',
        width: 80,
        height: 80,
        mean: [0, 0, 0],
        divisor: [255, 255, 255],
        color: 'BGR',
        crop_scale: 2.7,
        live_class: 1,
        output_mode: 'LOGITS',
      },
      quality: { min_face_pixels: 100, sharpness_reference: 100 },
    }),
  );
});
afterAll(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
});
describe('ONNX worker', () => {
  it('requires explicit opt-in for research evaluation under production Node settings', () => {
    expect(researchModelsAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(
      researchModelsAllowed({ NODE_ENV: 'production', FACE_ALLOW_RESEARCH_MODELS: 'true' }),
    ).toBe(true);
    expect(
      researchModelsAllowed({ NODE_ENV: 'production', FACE_ALLOW_RESEARCH_MODELS: 'false' }),
    ).toBe(false);
    expect(researchModelsAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(
      researchModelsAllowed({ NODE_ENV: 'development', FACE_ALLOW_RESEARCH_MODELS: 'false' }),
    ).toBe(false);
    expect(() =>
      researchModelsAllowed({ NODE_ENV: 'production', FACE_ALLOW_RESEARCH_MODELS: 'yes' }),
    ).toThrow();
  });
  it('runs detector, alignment, recognition and PAD with real ONNX Runtime sessions', async () => {
    const engine = await OnnxFaceEngine.load(manifestPath);
    const pixels = Buffer.alloc(640 * 640 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = i % 251;
    const image = await sharp(pixels, { raw: { width: 640, height: 640, channels: 3 } })
      .png()
      .toBuffer();
    const result = await engine.observe(image, 'test-nonce');
    expect(result.embedding).toHaveLength(512);
    expect(result.embedding[0]).toBe(1);
    expect(result.liveness_score).toBeGreaterThan(0.99);
    expect(result.quality_score).toBeGreaterThan(0);
    expect(result.image_sha256).toBe(hash(image));
    expect(result.nonce).toBe('test-nonce');
  });
  it('rejects missing models instead of returning a synthetic match', async () => {
    await expect(OnnxFaceEngine.load(join(folder, 'missing.json'))).rejects.toThrow();
  });
  it('checks model integrity before loading', async () => {
    const other = join(folder, 'bad.json');
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.recognizer.sha256 = '0'.repeat(64);
    await writeFile(other, JSON.stringify(manifest));
    await expect(OnnxFaceEngine.load(other)).rejects.toThrow('checksum');
  });
  it('requires explicit research permission before loading restricted models', async () => {
    const path = join(folder, 'research.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.usage = 'RESEARCH_ONLY';
    await writeFile(path, JSON.stringify(manifest));
    await expect(OnnxFaceEngine.load(path)).rejects.toThrow('Research-only');
    const engine = await OnnxFaceEngine.load(path, { allowResearch: true });
    await engine.close();
  });
  it('rejects incompatible detector tensors at startup', async () => {
    const path = join(folder, 'bad-detector.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.detector.score_outputs.reverse();
    await writeFile(path, JSON.stringify(manifest));
    await expect(OnnxFaceEngine.load(path)).rejects.toThrow('Unsupported SCRFD tensor shapes');
  });
  it('rejects a missing PAD live class at startup', async () => {
    const path = join(folder, 'bad-pad.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.pad.live_class = 2;
    await writeFile(path, JSON.stringify(manifest));
    await expect(OnnxFaceEngine.load(path)).rejects.toThrow('PAD live class not found');
  });
  it('matches the selected MiniFASNet crop and raw BGR normalization', () => {
    expect(miniFasNetCrop(640, 480, [100, 100, 200, 200], 2.7)).toEqual({
      left: 15,
      top: 15,
      right: 286,
      bottom: 286,
    });
    expect(miniFasNetCrop(640, 480, [0, 0, 100, 100], 2.7)).toEqual({
      left: 0,
      top: 0,
      right: 186,
      bottom: 186,
    });
    expect(Array.from(nchw(Buffer.from([10, 20, 255]), 1, 1, [0, 0, 0], [1, 1, 1], 'BGR'))).toEqual(
      [255, 20, 10],
    );
  });
  it('preserves identity alignment and stable logits', () => {
    const transform = similarityTransform(arcfaceLandmarks);
    expect(transform.a).toBeCloseTo(1);
    expect(transform.b).toBeCloseTo(0);
    expect(softmax([10000, 10000])).toEqual([0.5, 0.5]);
    expect(Array.from(nchw(Buffer.from([10, 20, 30]), 1, 1, [0, 0, 0], [1, 1, 1], 'BGR'))).toEqual([
      30, 20, 10,
    ]);
  });
});
it('validates the published OpenAPI document', async () => {
  const document = await SwaggerParser.validate(
    structuredClone(openapi) as unknown as OpenAPIV3_1.Document,
  );
  expect(document.info.title).toContain('Absensi');
});
