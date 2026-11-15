import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepositoryGit, repositoryEnvironment, inspectRepository } from '../src/service/repository-access.mjs';

test('Git probes and clones use gh credentials, retain Windows/custom profiles and proxies, and never put credentials in argv',async()=>{
  const source={Path:'C:\\Program Files\\Git\\cmd',UserProfile:'C:\\Users\\Ana Lee',AppData:'C:\\Users\\Ana Lee\\AppData',SystemRoot:'C:\\Windows',GH_CONFIG_DIR:'C:\\Private Profile',GH_TOKEN:'synthetic-secret',HTTPS_PROXY:'https://proxy.test',SSL_CERT_FILE:'C:\\Trust Store\\ca.pem',UNRELATED_SECRET:'excluded'};
  const calls=[];
  const git=createRepositoryGit({envSource:source,run:async(...args)=>{calls.push(args);return {stdout:'ok\n'};}});
  await git(['ls-remote','--exit-code','--','https://github.com/example/private','HEAD']);
  await git(['clone','--','https://github.com/example/private','C:\\Project With Spaces']);
  for(const [binary,args,options] of calls){
    assert.equal(binary,'git');assert.equal(options.windowsHide,true);assert.equal(options.env.USERPROFILE,source.UserProfile);
    assert.equal(options.env.GH_CONFIG_DIR,source.GH_CONFIG_DIR);assert.equal(options.env.GH_TOKEN,source.GH_TOKEN);
    assert.equal(options.env.UNRELATED_SECRET,undefined);assert.equal(options.env.GIT_TERMINAL_PROMPT,'0');
    assert.ok(args.includes('credential.https://github.com.helper=!gh auth git-credential'));
    assert.ok(args.includes('protocol.ssh.allow=never'));assert.ok(!JSON.stringify(args).includes('synthetic-secret'));
  }
  assert.deepEqual(calls[0][2].env,calls[1][2].env);
  assert.equal(calls[1][1].at(-1),'C:\\Project With Spaces');
});
for(const [code,error] of [
 ['git_missing',{code:'ENOENT'}],['empty_repository',{code:2}],
 ['git_authentication_failed',{code:128,stderr:'fatal: could not read Username: terminal prompts disabled synthetic-secret'}],
 ['repository_access_denied',{code:128,stderr:'Repository not found'}],
 ['dns_failed',{code:128,stderr:'Could not resolve host: github.com'}],
 ['tls_failed',{code:128,stderr:'SSL certificate problem'}],
 ['network_timeout',{code:'ETIMEDOUT'}],['git_failed',{code:128,stderr:'unrecognized failure synthetic-secret'}],
]) test(`repository diagnostics distinguish ${code} without sharing raw stderr`,async()=>{
  const result=await inspectRepository('https://github.com/example/private',{git:async()=>{throw error;},now:()=>123});
  assert.deepEqual(result,{waitingFor:code==='empty_repository'?'empty_repository':'github',code,checkedAt:123});
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
});
test('successful access, invalid URLs, timeout and explicit shutdown remain distinct',async()=>{
  let calls=0;const git=async()=>{calls++;};
  assert.deepEqual(await inspectRepository('https://github.com/example/private',{git,now:()=>12}),{waitingFor:null,code:'ready',checkedAt:12});
  assert.equal((await inspectRepository('https://other.test/private',{git})).code,'invalid_repository');assert.equal(calls,1);
  const timeout=AbortSignal.abort(new DOMException('timed out','TimeoutError'));
  assert.equal((await inspectRepository('https://github.com/example/private',{git:async()=>{throw new Error('aborted');},signal:timeout})).code,'network_timeout');
  const stop=AbortSignal.abort(new Error('shutdown'));
  await assert.rejects(inspectRepository('https://github.com/example/private',{git:async()=>{throw stop.reason;},signal:stop}),/shutdown/);
});

test('real Git obtains credentials from gh without preexisting global Git configuration',{skip:process.platform==='win32'},async t=>{
  const {execFile}=await import('node:child_process');
  const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
  const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const root=await mkdtemp(join(tmpdir(),'minions-git-credential-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'home'));await mkdir(join(root,'bin'));
  await writeFile(join(root,'bin','gh'),'#!/bin/sh\n[ "$1 $2" = "auth git-credential" ] || exit 1\nprintf "username=synthetic\\npassword=synthetic-secret\\n"\n',{mode:0o755});
  let resolved=false;
  const git=createRepositoryGit({envSource:{PATH:join(root,'bin')+':'+process.env.PATH,HOME:join(root,'home')},run:(command,args,options)=>new Promise((resolve,reject)=>{
    // No network. Git itself interprets the exact production credential helper config.
    const child=execFile(command,args,options,(error,stdout,stderr)=>{
      if(error)return reject(error);
      resolved=stdout.includes('password=synthetic-secret');resolve({stdout:'credential resolved',stderr:''});
    });
    child.stdin.end('protocol=https\nhost=github.com\n\n');
  })});
  await git(['credential','fill']);assert.equal(resolved,true);
});
