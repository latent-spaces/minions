// Disposable crash target. All inputs and records are synthetic temporary files.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRuntimeStore } from '../../src/service/store.mjs';
import { createRuntimeControllers } from './recorded-controllers.mjs';
import { createFakeAdapterFactory } from './runtime-fake-adapter.mjs';
const directory = process.argv[2];
const store = await openRuntimeStore({ directory: join(directory, 'state') });
const controllers = createRuntimeControllers({ store, adapterFactory: createFakeAdapterFactory({
  command: process.execPath, args: [fileURLToPath(new URL('./runtime-fake-native.mjs', import.meta.url))], cwd: directory,
  env: { PATH: process.env.PATH },
  initialInput: (_mission, steering) => ({ steering, events: join(directory, 'events.jsonl'), ...(steering.length ? { gate: join(directory, 'never-opened'), childPidFile: join(directory, 'child.pid') } : {}) }),
}) });
process.on('message', async ({ id, command, query }) => {
  try { process.send({ id, result: command ? await controllers.accept(command) : await controllers.getMission(query) }); }
  catch (error) { process.send({ id, error: error.message }); }
});
process.send({ ready: true });
