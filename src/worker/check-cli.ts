import { OnnxFaceEngine } from './engine.js';

try {
  const path = process.env.FACE_MANIFEST_PATH;
  if (!path) throw new Error('FACE_MANIFEST_PATH is not configured');
  const engine = await OnnxFaceEngine.load(path, {
    allowResearch: process.env.NODE_ENV !== 'production',
  });
  await engine.close();
  console.log(
    'Face model checksums and ONNX startup inference passed. Accuracy is not yet proven.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Model validation failed');
  process.exitCode = 1;
}
