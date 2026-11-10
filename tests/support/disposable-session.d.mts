export const repository: string;
export function executable(packageName: string, name: string): string;
export function runProcess(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<number>;
export function disposableTarget(env?: NodeJS.ProcessEnv): { session: string; store: string };
export function testEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function withDisposableSession(command: (session: { session: string; folder: string; env: NodeJS.ProcessEnv }) => string[] | Promise<string[]>, options?: { kind?: 'tests' | 'benchmarks'; envPatch?: NodeJS.ProcessEnv; cwd?: string }): Promise<number>;
