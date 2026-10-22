import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hash } from '../src/shared/security/crypto.js';
import { researchAssets, researchManifest } from '../src/worker/research-models.js';
import { OnnxFaceEngine } from '../src/worker/engine.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = resolve(root, 'models/research');

async function existing(name: string, expectedHash: string) {
  try {
    const data = await readFile(resolve(folder, name));
    if (hash(data) !== expectedHash) throw new Error(`Checksum mismatch for existing ${name}`);
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function download(asset: { name: string; url: string; sha256: string }) {
  const saved = await existing(asset.name, asset.sha256);
  if (saved) return;
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed for ${asset.name}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (hash(data) !== asset.sha256) throw new Error(`Download checksum mismatch: ${asset.name}`);
  await writeFile(resolve(folder, asset.name), data, { flag: 'wx' });
  console.log(`Downloaded and verified ${asset.name}`);
}

try {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Research setup is disabled in production');
  console.log(
    'Local non-commercial research only. This package is not approved for operational attendance.',
  );
  await mkdir(folder, { recursive: true });
  await download(researchAssets.archive);
  await download(researchAssets.pad);
  for (const [member, asset] of [
    ['det_500m.onnx', researchManifest.detector],
    ['w600k_mbf.onnx', researchManifest.recognizer],
  ] as const) {
    if (await existing(asset.path, asset.sha256)) continue;
    const archive = resolve(folder, researchAssets.archive.name);
    const extracted =
      process.platform === 'win32'
        ? spawnSync('tar', ['-xOf', archive, member], { maxBuffer: 32 * 1024 * 1024 })
        : spawnSync('unzip', ['-p', archive, member], { maxBuffer: 32 * 1024 * 1024 });
    if (extracted.error || extracted.status !== 0)
      throw new Error(
        'Archive extraction failed. Windows requires tar; Linux/macOS requires unzip.',
      );
    if (hash(extracted.stdout) !== asset.sha256)
      throw new Error(`Extracted checksum mismatch: ${member}`);
    await writeFile(resolve(folder, asset.path), extracted.stdout, { flag: 'wx' });
  }
  const contents = JSON.stringify(researchManifest, null, 2) + '\n';
  const manifestPath = resolve(folder, 'manifest.json');
  if (!(await existing('manifest.json', hash(contents))))
    await writeFile(manifestPath, contents, { flag: 'wx' });
  const engine = await OnnxFaceEngine.load(manifestPath, { allowResearch: true });
  await engine.close();
  console.log(
    'Model checksums and ONNX startup inference passed. Manifest: models/research/manifest.json',
  );
  console.log('Attendance thresholds remain unset until calibration with real participants.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Model setup failed');
  process.exitCode = 1;
}
