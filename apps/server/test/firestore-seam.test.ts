import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// Self-hosted storage adapters replace src/firestore.ts alone; every other module takes the database API from it.
// The SQLite store uses SDK value classes (Timestamp, FieldPath, FieldValue, Filter), so callers keep one set of them.
test('only src/firestore.ts and the SQLite store import firebase-admin/firestore', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const sources = (readdirSync(root, { recursive: true }) as string[]).filter(path => path.endsWith('.ts'));
  const direct = sources.filter(path => readFileSync(join(root, path), 'utf8').includes('firebase-admin/firestore'))
    .map(path => relative(root, join(root, path)).split('\\').join('/'));
  expect(sources.length).toBeGreaterThan(100);
  expect(direct.sort()).toEqual(['firestore.ts', 'storage/sqlite-firestore.ts']);
  // The SQLite store may take value classes only, never the Firestore client.
  const adapter = readFileSync(join(root, 'storage/sqlite-firestore.ts'), 'utf8');
  const imports = [...adapter.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'firebase-admin\/firestore'/g)]
    .flatMap(match => match[1]!.split(',').map(name => name.trim()).filter(Boolean));
  expect(adapter.match(/firebase-admin\/firestore/g)).toHaveLength(imports.length ? 1 : 0);
  expect(imports.sort()).toEqual(['FieldPath', 'FieldValue', 'Filter', 'Timestamp']);
});
