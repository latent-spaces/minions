// One reading of which environment this process serves: the self-hosted engine, or a disposable test session that
// tests/run.mjs starts. Guards that differ by environment ask this. Classification never grants authority: callers
// keep their own stricter conditions.
export type DeploymentKind = 'self-hosted' | 'test' | 'unconfigured';

export function deploymentKind(env: NodeJS.ProcessEnv = process.env): DeploymentKind {
  if (env.MINIONS_ENGINE !== undefined) return env.MINIONS_ENGINE === 'self-hosted' ? 'self-hosted' : 'unconfigured';
  if (env.NODE_ENV === 'test' && /^minions-(tests|benchmarks)-[a-f0-9]{12}$/.test(env.MINIONS_TEST_SESSION ?? '')) return 'test';
  return 'unconfigured';
}
