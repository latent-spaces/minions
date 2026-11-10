import test from 'node:test';
import assert from 'node:assert/strict';
import {waitingTitle} from '../src/ui/agent-running-state';
import {startMessage,type StartRequest} from '../src/web-agent-start';
test('repository waits describe the observed failure without inventing an invitation problem',()=>{
  for(const [code,phrase] of [['git_authentication_failed','Git authentication'],['dns_failed','network'],['tls_failed','certificate'],['git_missing','Git is missing'],['network_timeout','timed out']]){
    const repository={waitingFor:'github' as const,code,checkedAt:123};
    const title=waitingTitle('github',repository);
    assert.ok(title.includes(phrase));assert.doesNotMatch(title,/invitation|owner’s computer adds/);
    assert.equal(startMessage({state:'pending',waitingFor:'github',repository} as StartRequest),title);
  }
  assert.doesNotMatch(waitingTitle('github'),/invitation/);
  assert.match(startMessage({state:'failed',code:'cancelled'} as StartRequest),/will not launch/);
});
