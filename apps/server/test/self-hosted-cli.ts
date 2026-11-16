import { fileURLToPath } from 'node:url';

/** Ordinary server tests use source; standalone acceptance exercises the documented compiled entry. */
export function selfHostedCli(args: string[]): string[] {
  const built = process.env.MINIONS_TEST_ENGINE_BUILD === '1';
  const entry = new URL(built ? '../dist/self-hosted-main.js' : '../src/self-hosted-main.ts', import.meta.url);
  return [...(built ? [] : ['--import', 'tsx']), fileURLToPath(entry), ...args];
}
