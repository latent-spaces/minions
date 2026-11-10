import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { claimWorkerCheckout, readMachineId } from '../src/checkout-ownership.mjs';

const guid = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('Windows machine identity is read from MachineGuid through the absolute reg.exe path', () => {
  const calls = [];
  const run = (file, args) => { calls.push({ file, args }); return `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${guid}\r\n\r\n`; };
  assert.equal(readMachineId('win32', run), guid);
  assert.match(calls[0].file, /^[A-Za-z]:\\.*\\System32\\reg\.exe$/i);
  assert.deepEqual(calls[0].args, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
});

test('machine identity stays unknown when the platform output has no identifier', () => {
  assert.equal(readMachineId('win32', () => 'ERROR: The system was unable to find the specified registry key or value.'), undefined);
  assert.equal(readMachineId('darwin', () => '"IOPlatformSerialNumber" = "X"'), undefined);
  assert.equal(readMachineId('freebsd', () => assert.fail('no command expected')), undefined);
});

test('a ticket held by a live process refuses the claim and names the ticket file', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mlswarm-ownership-busy-')));
  const registryRoot = join(root, 'registry'), folder = join(root, 'repo');
  await mkdir(registryRoot, { mode: 0o700 }); await mkdir(folder);
  const ticket = join(registryRoot, `ticket-${randomUUID()}.json`);
  await writeFile(ticket, JSON.stringify({ schema: 1, pid: process.ppid, machine: null, choosing: false, number: 1, createdAt: Date.now() }), { mode: 0o600 });
  await chmod(ticket, 0o600);
  await assert.rejects(claimWorkerCheckout({ folder, agentId: 'a', project: 'p', registryRoot }),
    error => error.message.includes(`remove ${ticket} and retry`) && error.message.includes('No worker was stopped'));
});
