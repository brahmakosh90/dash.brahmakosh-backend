import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'tests', '.git']);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    SKIP.has(e.name) ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []
  );

test('the duplicate authMiddleware.js no longer exists', () => {
  assert.equal(fs.existsSync(path.join(root, 'middleware', 'authMiddleware.js')), false);
});

test('no file imports the removed authMiddleware module', () => {
  const offenders = walk(root).filter((f) => /middleware\/authMiddleware/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(root, f)), []);
});

test('every authenticate import resolves to middleware/auth.js', () => {
  const re = /import\s*\{[^}]*\b(authenticate|authenticateToken|authMiddleware)\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/g;
  const bad = [];
  for (const f of walk(path.join(root, 'routes'))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) {
      const resolved = path.resolve(path.dirname(f), m[2]);
      if (resolved !== path.join(root, 'middleware', 'auth.js')) bad.push(`${path.relative(root, f)} -> ${m[2]}`);
    }
  }
  assert.deepEqual(bad, []);
});
