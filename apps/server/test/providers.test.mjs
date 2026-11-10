import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { childEnv, createProvider, passEnvNames } from '../../../packages/agent-cli/runtime/providers.mjs';
const settings = { claude: 'claude', codex: 'codex', turnBudgetUsd: 0 };
test('Codex retains the sandbox and uses native automatic review for authorized local work', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'codex-access-'));
  try {
    const instructionsFile = join(folder, 'instructions.md'); writeFileSync(instructionsFile, 'rules');
    const fake = join(folder, 'codex'); writeFileSync(fake, '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
    const standard = await createProvider('codex', { ...settings, codex: fake, permissionMode:'acceptEdits' }).invocation({prompt:'work',instructionsFile,
      bridge:{url:'http://127.0.0.1:4000/mcp',headers:{Authorization:'Bearer t'}},session:{id:null},resuming:false,repoDir:folder,clientVersion:'kit-0123456789ab'});
    expect(standard.rpc.startParams).toMatchObject({sandbox:'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'auto_review'});
    const config=standard.args.filter((_,i)=>standard.args[i-1]==='-c');
    expect(config).toEqual(expect.arrayContaining(['sandbox_mode="workspace-write"','approval_policy="on-request"','approvals_reviewer="auto_review"']));
    expect(standard.args.join(' ')).not.toMatch(/danger-full-access/);
    expect(standard.rpc).not.toHaveProperty('commandApproval');
    expect(config.find(value=>value.startsWith('developer_instructions='))).toContain('require explicit human approval');
    for(const mode of ['bypassPermissions','plan','default','dontAsk'])await expect(createProvider('codex',{...settings,permissionMode:mode}).preflight()).rejects.toThrow('local-development');
  } finally { rmSync(folder,{recursive:true,force:true}); }
});
test('model clients receive allowlisted, provider-specific and operator-named variables only', () => {
  const source = { PATH: '/bin', HOME: '/home/a', LANG: 'C', LC_ALL: 'C', AWS_SECRET_ACCESS_KEY: 'x', GH_TOKEN: 'x', NODE_OPTIONS: '--x',
    ANTHROPIC_API_KEY: 'a', CLAUDE_CONFIG_DIR: '/c', OPENAI_API_KEY: 'o', CODEX_HOME: '/x', EXTRA_NAMED: 'e' };
  expect(childEnv('claude', source)).toEqual({ PATH: '/bin', HOME: '/home/a', LANG: 'C', LC_ALL: 'C', ANTHROPIC_API_KEY: 'a', CLAUDE_CONFIG_DIR: '/c' });
  expect(childEnv('codex', source)).toEqual({ PATH: '/bin', HOME: '/home/a', LANG: 'C', LC_ALL: 'C', OPENAI_API_KEY: 'o', CODEX_HOME: '/x' });
  expect(childEnv('claude', source, ['EXTRA_NAMED', 'GH_TOKEN'])).toMatchObject({ EXTRA_NAMED: 'e', GH_TOKEN: 'x' });
  expect(childEnv('codex', { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', Secret: 'x' }, [], 'win32')).toEqual({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows' });
  expect(childEnv('codex', { Path: '/bin' }, [], 'linux')).toEqual({});
  expect(passEnvNames(' GH_TOKEN, HTTPS_PROXY ,')).toEqual(['GH_TOKEN', 'HTTPS_PROXY']);
  expect(passEnvNames(undefined)).toEqual([]);
  for (const bad of ['GH TOKEN', 'A=B', '1ABC', Array.from({ length: 65 }, (_, i) => `V${i}`).join(',')])
    expect(() => createProvider('claude', { ...settings, passEnv: bad })).toThrow('PILOT_PASS_ENV');
  const previous = process.env.OPE45_SENTINEL; process.env.OPE45_SENTINEL = 'secret';
  try {
    expect(createProvider('claude', settings).environment({ PILOT_BRIDGE_TOKEN: 't' })).not.toHaveProperty('OPE45_SENTINEL');
    expect(createProvider('codex', settings).environment({ PILOT_BRIDGE_TOKEN: 't' })).toMatchObject({ PILOT_BRIDGE_TOKEN: 't' });
    expect(createProvider('claude', { ...settings, passEnv: 'OPE45_SENTINEL' }).environment()).toMatchObject({ OPE45_SENTINEL: 'secret' });
  } finally { if (previous === undefined) delete process.env.OPE45_SENTINEL; else process.env.OPE45_SENTINEL = previous; }
});
