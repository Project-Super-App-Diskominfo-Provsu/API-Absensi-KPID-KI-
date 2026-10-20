import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const sourceRoot = resolve(root, 'src');
const label = (path) => relative(sourceRoot, path).replaceAll('\\', '/');
function list(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? list(path) : path.endsWith('.ts') ? [path] : [];
  });
}
const graph = new Map();
const errors = [];
for (const path of list(sourceRoot)) {
  const name = label(path);
  const source = readFileSync(path, 'utf8');
  // Static declarations only; TypeScript typecheck validates full module resolution.
  const declarations = source.matchAll(
    /^[ \t]*(?:import|export)\s+(?:(type\s+)?(\{[^}]*\}|[\w$]+(?:\s*,\s*\{[^}]*\})?|\*\s+as\s+[\w$]+|\*)\s+from\s+)?(['"])([^'"]+)\3\s*;?/gm,
  );
  const edges = [];
  for (const declaration of declarations) {
    const [, typeOnly, clause, , specifier] = declaration;
    if (!specifier.startsWith('.')) {
      if (/\.(service|model)\.ts$/.test(name) && specifier === 'express') {
        errors.push(`${name}: HTTP dependencies belong in routes/controllers/middleware.`);
      }
      continue;
    }
    const dependency = resolve(dirname(path), specifier.replace(/\.js$/, '.ts'));
    const target = label(dependency);
    if (!existsSync(dependency)) errors.push(`${name}: missing import ${specifier}.`);
    const module = name.match(/^modules\/([^/]+)\//)?.[1];
    const targetModule = target.match(/^modules\/([^/]+)\//)?.[1];
    if (
      module &&
      targetModule &&
      module !== targetModule &&
      /\.(controller|route)\.ts$/.test(target)
    ) {
      errors.push(`${name}: do not import HTTP handlers from another module (${target}).`);
    }
    if (/\.(service|model)\.ts$/.test(name) && /\.(controller|route)\.ts$/.test(target)) {
      errors.push(`${name}: business/data layers cannot import HTTP handlers (${target}).`);
    }
    if (/^(shared|database|config|worker)\//.test(name) && targetModule) {
      errors.push(`${name}: infrastructure and workers cannot depend on API modules (${target}).`);
    }
    const onlyTypes =
      Boolean(typeOnly) ||
      (clause?.startsWith('{') &&
        clause
          .slice(1, -1)
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
          .every((v) => v.startsWith('type ')));
    if (!onlyTypes) edges.push(dependency);
  }
  graph.set(path, edges);
}
const visited = new Set();
const active = new Set();
function visit(path, chain) {
  if (active.has(path)) {
    errors.push(`Runtime import cycle: ${[...chain, path].map(label).join(' -> ')}`);
    return;
  }
  if (visited.has(path)) return;
  active.add(path);
  for (const next of graph.get(path) ?? []) visit(next, [...chain, path]);
  active.delete(path);
  visited.add(path);
}
for (const path of graph.keys()) visit(path, []);
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Architecture checks passed (${graph.size} source files; no runtime import cycles).`);
}
