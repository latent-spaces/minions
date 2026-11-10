import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { prepareSupervisedModel } from '../src/model-guard.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const supervised = ['darwin', 'linux'].includes(process.platform);

test('unsupported independent supervision fails before reading launch options or spawning a worker', {
 skip: ['darwin','linux','win32'].includes(process.platform) ? 'This host supports independent process supervision.' : false,
}, () => {
 const options = new Proxy({}, { get() { assert.fail('Unsupported supervision must fail before inspecting launch options.'); } });
 assert.throws(() => prepareSupervisedModel(options), /Independent worker process supervision requires macOS, Linux or Windows/);
});

test('the guard backstop ends a native process at its fixed deadline; nothing extends it (fake process, no model)',{timeout:10000,skip:supervised ? false : 'Independent process supervision is unavailable on this platform.'},async()=>{
 const deadline=Date.now()+1500;
 const child=prepareSupervisedModel({cwd:tmpdir(),env:process.env,stdio:['ignore','pipe','pipe'],deadline});
 assert.equal(child.extendDeadline,undefined);
 child.authorize(process.execPath,['-e','setInterval(()=>{},1000)']);
 let closed=false;const reaped=once(child,'close').then(()=>{closed=true;});
 try {
  await reaped;assert.ok(Date.now()>=deadline-50);
 }finally{if(!closed){child.kill('SIGKILL');await reaped;}}
});
