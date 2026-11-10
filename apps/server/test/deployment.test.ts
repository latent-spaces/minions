import { describe, expect, it } from 'vitest';
import { deploymentKind } from '../src/deployment.js';

const session = { NODE_ENV: 'test', MLSWARM_TEST_SESSION: 'mlswarm-tests-0123456789ab' };

describe('deployment kind', () => {
  it('treats only an exact engine setting as self-hosted', () => {
    expect(deploymentKind({ MLSWARM_ENGINE: 'self-hosted' })).toBe('self-hosted');
    for (const MLSWARM_ENGINE of ['', 'hosted', 'Self-Hosted', 'self-hosted '])
      expect(deploymentKind({ MLSWARM_ENGINE })).toBe('unconfigured');
  });

  it('recognizes a disposable test session only under NODE_ENV=test and never alongside an engine setting', () => {
    expect(deploymentKind(session)).toBe('test');
    expect(deploymentKind({ ...session, MLSWARM_TEST_SESSION: 'mlswarm-benchmarks-0123456789ab' })).toBe('test');
    for (const patch of [{ NODE_ENV: 'development' }, { NODE_ENV: undefined }, { MLSWARM_TEST_SESSION: 'mlswarm-tests-0123' },
      { MLSWARM_TEST_SESSION: 'mlswarm-tests-0123456789AB' }, { MLSWARM_TEST_SESSION: 'other-tests-0123456789ab' }, { MLSWARM_ENGINE: 'hosted' }])
      expect(deploymentKind({ ...session, ...patch })).toBe('unconfigured');
    expect(deploymentKind({ ...session, MLSWARM_ENGINE: 'self-hosted' })).toBe('self-hosted');
  });

  it('leaves any other process unconfigured, including one carrying old cloud settings', () => {
    expect(deploymentKind({})).toBe('unconfigured');
    for (const env of [{ GCLOUD_PROJECT: 'karma42-beta' }, { GCLOUD_PROJECT: 'demo-x', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
      { GOOGLE_APPLICATION_CREDENTIALS: '/key.json' }])
      expect(deploymentKind(env)).toBe('unconfigured');
  });
});
