import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCloudClient } from '../src/service/cloud-client.mjs';
const target = { site: 'https://runtime.invalid', ownerId: 'owner', projectId: 'project', agentId: 'agent' };
const mission = () => ({ missionId: randomUUID(), target });
function peer(responses) {
  const requests = [];
  const client = createCloudClient({ target, url: `${target.site}/p/project`, token: 'private-test-token', fetchImpl: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), headers: options.headers, signal: options.signal, redirect: options.redirect });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify(response.body ?? response), { status: response.status ?? 200, headers: response.headers });
  } });
  return { client, requests };
}

test('cloud endpoints and all commands stay bound to the trusted target', async () => {
  assert.throws(() => createCloudClient({ target, url: 'https://other.invalid/p/project', token: 'test' }));
  assert.throws(() => createCloudClient({ target, url: `${target.site}/p/project?token=secret`, token: 'test' }));
  const p = peer([]), m = { ...mission(), target: { ...target, ownerId: 'other' } };
  await assert.rejects(p.client.start(m), { code: 'forbidden', fatal: true });
  await assert.rejects(p.client.send({ kind: 'turn_report', target: m.target, missionId: m.missionId, runId: m.missionId }), { code: 'forbidden' });
  assert.equal(p.requests.length, 0);
});

test('cloud refusal classification preserves retry delay without exposing remote secrets', async () => {
  for (const [status, code, fatal] of [[401,'unauthorized',true],[403,'forbidden',true],[409,'run_superseded',true],[429,'rate_limited',false],[503,'internal_error',false]]) {
    const p = peer([{ status, body: { error: code, message: 'remote-secret', retry_after_seconds: 17 } }]);
    await assert.rejects(p.client.observe(mission()), error => { assert.equal(error.code, code); assert.equal(error.fatal, fatal); assert.equal(error.retryAfter, 17); assert.doesNotMatch(error.message, /remote-secret|private-test-token/); return true; });
  }
  const p = peer([new Error('credential-private-test-token')]);
  await assert.rejects(p.client.observe(mission()), error => error.code === 'unavailable' && !error.message.includes('private-test-token'));
});

test('held project control carries the exact revision and rejects malformed pause identities', async () => {
  const project = {started:true,paused:true,closed:false,revision:7,pauseRequest:{revision:7,requestedAt:1000}};
  const p = peer([{project}]), m = mission();
  assert.deepEqual(await p.client.projectControl(m,{afterRevision:6}),project);
  assert.equal(p.requests[0].url,`${target.site}/p/project/v2/project-control`);
  assert.deepEqual(p.requests[0].body,{run_id:m.missionId,after_revision:6});
  for (const pauseRequest of [{revision:8,requestedAt:1000},{revision:7,requestedAt:-1},{revision:'7',requestedAt:1000}]) {
    const malformed = peer([{project:{...project,pauseRequest}}]);
    await assert.rejects(malformed.client.projectControl(m),{code:'invalid_reply'});
  }
});
