import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const storeUrl = new URL('../src/service/store.mjs', import.meta.url).href;
async function fixture(t, preload) {
  const directory = await mkdtemp(join(tmpdir(), 'minions-store-ownership-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bootstrap = join(directory, 'bootstrap.mjs');
  await writeFile(bootstrap, preload);
  return async script => run(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import {openRuntimeStore} from ${JSON.stringify(storeUrl)};
    const directory=${JSON.stringify(join(directory, 'store'))};
    ${script}
  `], { env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(bootstrap).href}` }, timeout: 20000 });
}

for (const workerOnly of [false, true]) {
 test(`runtime opens and reopens without getuid in ${workerOnly ? 'SQLite worker only' : 'service and SQLite worker'}`, async t => {
  const runFixture = await fixture(t, `import {isMainThread} from 'node:worker_threads'; if (${!workerOnly} || !isMainThread) process.getuid = undefined;`);
  await runFixture(`
    let store = await openRuntimeStore({directory});
    try { assert.equal((await store.health()).ready, true); }
    finally { await store.close(); }
    store = await openRuntimeStore({directory});
    try { assert.equal((await store.health()).schemaVersion, 6); }
    finally { await store.close(); }
  `);
});

}

for (const workerOnly of [false, true]) {
  test(`POSIX rejects foreign ownership in ${workerOnly ? 'SQLite worker' : 'service'}`, {skip: typeof process.getuid !== 'function'}, async t => {
    const runFixture = await fixture(t, `
      import {isMainThread} from 'node:worker_threads';
      if (${!workerOnly} || !isMainThread) {
        const uid = process.getuid(); process.getuid = () => uid + 1;
      }
    `);
    await runFixture(`await assert.rejects(openRuntimeStore({directory}), {code:'unsafe_directory'});`);
  });
}

test('missing getuid still rejects symlink directories and database files', {skip: process.platform === 'win32' && !process.env.MINIONS_TEST_WINDOWS_SYMLINKS}, async t => {
  const runFixture = await fixture(t, 'process.getuid = undefined;');
  await runFixture(`
    const {mkdir, symlink, rm, writeFile} = await import('node:fs/promises');
    const target = directory + '-target';
    await mkdir(target);
    await symlink(target, directory, 'dir');
    await assert.rejects(openRuntimeStore({directory}), {code:'unsafe_directory'});
    await rm(directory);
    await mkdir(directory);
    const file = directory + '-database';
    await writeFile(file, '');
    await symlink(file, directory + '/runtime.sqlite', 'file');
    await assert.rejects(openRuntimeStore({directory}), {code:'unsafe_directory'});
  `);
});
