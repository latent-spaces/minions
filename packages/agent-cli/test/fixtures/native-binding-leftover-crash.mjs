// Disposable service stand-in: one fake Claude turn leaves a detached server.
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeMixedNativeFixtures } from './mixed-native-fixtures.mjs';
import { createNativeAdapterFactory } from '../../src/service/native-bindings.mjs';

const { root, missionId } = JSON.parse(process.argv[2]);
const fixtures = await makeMixedNativeFixtures(root, [['garden', 'claude']]);
const binding = fixtures.bindings[0], pidFile = join(root, 'detached.pid');
await writeFile(fixtures.executables.claude, `#!${process.execPath}
const fs = require('node:fs'), { spawn } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('Claude Code synthetic'); process.exit(0); }
const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
server.unref(); fs.writeFileSync(${JSON.stringify(pidFile)}, String(server.pid));
console.log(JSON.stringify({ type: 'result', is_error: false, num_turns: 1, result: 'Synthetic complete.\\nWORK_NEXT: waiting' }));
`, { mode: 0o700 });
const mission = { target: binding.target, missionId, generation: 1, execution: { provider: 'claude', model: null }, scope: 'Synthetic retained mission resources' };
const adapter = await createNativeAdapterFactory(fixtures)(mission);
const result = await adapter.run({ prompt: 'Synthetic only', signal: new AbortController().signal });
if (!result.cleanupConfirmed || result.failed) throw new Error('Synthetic turn failed.');
process.send({ ready: true, mission, binding: { target: binding.target, folder: binding.folder, stateDir: binding.stateDir, repository: binding.repository },
  registryRoot: fixtures.registryRoot, executables: fixtures.executables, envSource: fixtures.envSource, serverPid: Number(await readFile(pidFile, 'utf8')) });
setInterval(() => {}, 1000);
