export interface Detection {
  score: number;
  box: [number, number, number, number];
  landmarks: number[];
}
export function nms(detections: Detection[], threshold: number): Detection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const result: Detection[] = [];
  while (sorted.length) {
    const best = sorted.shift()!;
    result.push(best);
    for (let i = sorted.length - 1; i >= 0; i--) {
      const other = sorted[i]!;
      const area = (b: number[]) => Math.max(0, b[2]! - b[0]!) * Math.max(0, b[3]! - b[1]!);
      const intersection =
        Math.max(0, Math.min(best.box[2], other.box[2]) - Math.max(best.box[0], other.box[0])) *
        Math.max(0, Math.min(best.box[3], other.box[3]) - Math.max(best.box[1], other.box[1]));
      const union = area(best.box) + area(other.box) - intersection;
      if (union > 0 && intersection / union > threshold) sorted.splice(i, 1);
    }
  }
  return result;
}
export const arcfaceLandmarks = [
  38.2946, 51.6963, 73.5318, 51.5014, 56.0252, 71.7366, 41.5493, 92.3655, 70.7299, 92.2041,
];
export function similarityTransform(source: number[], target: number[] = arcfaceLandmarks) {
  if (source.length !== 10 || target.length !== 10) throw new Error('Five landmarks required');
  let sx = 0,
    sy = 0,
    tx = 0,
    ty = 0;
  for (let i = 0; i < 10; i += 2) {
    sx += source[i]!;
    sy += source[i + 1]!;
    tx += target[i]!;
    ty += target[i + 1]!;
  }
  sx /= 5;
  sy /= 5;
  tx /= 5;
  ty /= 5;
  let a = 0,
    b = 0,
    denominator = 0;
  for (let i = 0; i < 10; i += 2) {
    const x = source[i]! - sx,
      y = source[i + 1]! - sy,
      u = target[i]! - tx,
      v = target[i + 1]! - ty;
    a += x * u + y * v;
    b += x * v - y * u;
    denominator += x * x + y * y;
  }
  if (denominator < 1e-8) throw new Error('Degenerate landmarks');
  a /= denominator;
  b /= denominator;
  return { a, b, dx: tx - a * sx + b * sy, dy: ty - b * sx - a * sy };
}
export function alignFace(rgb: Buffer, width: number, height: number, landmarks: number[]): Buffer {
  const { a, b, dx, dy } = similarityTransform(landmarks);
  const determinant = a * a + b * b;
  if (determinant < 1e-10) throw new Error('Invalid alignment');
  const out = Buffer.alloc(112 * 112 * 3);
  for (let y = 0; y < 112; y++)
    for (let x = 0; x < 112; x++) {
      const px = (a * (x - dx) + b * (y - dy)) / determinant,
        py = (-b * (x - dx) + a * (y - dy)) / determinant;
      const x0 = Math.floor(px),
        y0 = Math.floor(py),
        fx = px - x0,
        fy = py - y0;
      for (let c = 0; c < 3; c++) {
        let value = 0;
        for (let oy = 0; oy < 2; oy++)
          for (let ox = 0; ox < 2; ox++) {
            const ix = x0 + ox,
              iy = y0 + oy;
            if (ix >= 0 && iy >= 0 && ix < width && iy < height)
              value += rgb[(iy * width + ix) * 3 + c]! * (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
          }
        out[(y * 112 + x) * 3 + c] = Math.round(value);
      }
    }
  return out;
}
export function nchw(
  rgb: Buffer,
  width: number,
  height: number,
  mean: number[],
  divisor: number[],
  color: 'RGB' | 'BGR',
): Float32Array {
  const result = new Float32Array(width * height * 3),
    plane = width * height;
  for (let c = 0; c < 3; c++)
    for (let i = 0; i < plane; i++)
      result[c * plane + i] =
        (rgb[i * 3 + (color === 'RGB' ? c : 2 - c)]! - mean[c]!) / divisor[c]!;
  return result;
}
export function softmax(values: number[]): number[] {
  if (values.length < 2 || values.some((v) => !Number.isFinite(v)))
    throw new Error('Invalid PAD logits');
  const max = Math.max(...values),
    exp = values.map((v) => Math.exp(v - max)),
    sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / sum);
}
export function sharpness(rgb: Buffer, width: number, height: number): number {
  const gray = (x: number, y: number) => {
    const i = (y * width + x) * 3;
    return 0.299 * rgb[i]! + 0.587 * rgb[i + 1]! + 0.114 * rgb[i + 2]!;
  };
  let sum = 0,
    squared = 0,
    count = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const v = gray(x - 1, y) + gray(x + 1, y) + gray(x, y - 1) + gray(x, y + 1) - 4 * gray(x, y);
      sum += v;
      squared += v * v;
      count++;
    }
  return count ? Math.max(0, squared / count - (sum / count) ** 2) : 0;
}
