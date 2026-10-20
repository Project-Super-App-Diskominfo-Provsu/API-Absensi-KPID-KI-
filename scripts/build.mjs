import { rmSync, lstatSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = resolve(root, 'dist');
if (dirname(output) !== root || (existsSync(output) && lstatSync(output).isSymbolicLink())) {
  throw new Error('Build output must be the project-owned dist directory.');
}
rmSync(output, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
