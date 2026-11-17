// Test-only preload: `node --import <this file> <entry>` runs a child process (for example the standalone
// engine CLI) under the loopback-only guard from its first line, because the guard covers only the thread
// that installs it. On exit the refusal log is written as JSON to MINIONS_TEST_NETWORK_LOG, so the parent
// test can assert that nothing tried to leave the machine. Without that variable the preload refuses to run.
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { installLoopbackOnlyNetwork } from './loopback-only-network.mjs';

const log = process.env.MINIONS_TEST_NETWORK_LOG;
if (!log || !isAbsolute(log)) throw new Error('Set MINIONS_TEST_NETWORK_LOG to the absolute path of a new refusal log.');
const guard = installLoopbackOnlyNetwork();
// 'wx' never overwrites a log another process already wrote.
process.once('exit', () => writeFileSync(log, JSON.stringify(guard.refused), { flag: 'wx' }));
