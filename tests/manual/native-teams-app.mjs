// Actual app acceptance uses a fresh disposable local session, never saved participant state.
import { fileURLToPath } from 'node:url';
import { executable, withDisposableSession } from '../support/disposable-session.mjs';
if (process.argv.length !== 2) throw new Error('This check uses only disposable local session.');
process.exitCode = await withDisposableSession(async ({ folder }) => [process.execPath, executable('tsx', 'tsx'), fileURLToPath(new URL('./native-teams-app.ts', import.meta.url)), folder]);
