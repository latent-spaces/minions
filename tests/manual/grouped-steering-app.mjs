import { fileURLToPath } from 'node:url';
import { executable, withDisposableSession } from '../support/disposable-session.mjs';
if (process.argv.length !== 2) throw new Error('This check uses disposable local session and takes no arguments.');
process.exitCode = await withDisposableSession(async ({ folder }) => [process.execPath, executable('tsx', 'tsx'), fileURLToPath(new URL('./grouped-steering-app.ts', import.meta.url)), folder]);
