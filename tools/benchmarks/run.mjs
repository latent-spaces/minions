// Explicit local studies, run in the test launcher's disposable session (its own SQLite store and media folder).
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { executable, withDisposableSession } from '../../tests/support/disposable-session.mjs';
const [study, ...args] = process.argv.slice(2);
const studies = new Set(['context-footprint']);
try {
  if (!studies.has(study)) throw new Error('Choose context-footprint. Studies are explicit; none run during startup.');
  // Keep operator-selected report destinations relative to the invoking folder.
  if (args[0]) args[0] = resolve(args[0]);
  process.exitCode = await withDisposableSession(() => [process.execPath, executable('tsx', 'tsx'),
    fileURLToPath(new URL(`./${study}.ts`, import.meta.url)), ...args], { kind: 'benchmarks' });
} catch (error) { console.error(error.message); process.exitCode = 1; }
