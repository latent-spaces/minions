// Bounded actual-app acceptance; disposable local session, no models or persistent data.
import { fileURLToPath } from 'node:url';
import { executable, withDisposableSession } from '../support/disposable-session.mjs';
if (process.argv.length !== 2) throw new Error('This check uses only disposable local session.');
process.exitCode = await withDisposableSession(async ({ folder }) => [process.execPath, executable('tsx', 'tsx'), fileURLToPath(new URL('./native-tasks-app.ts', import.meta.url)), folder]);
