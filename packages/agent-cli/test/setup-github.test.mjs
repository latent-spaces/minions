import test from 'node:test';
import assert from 'node:assert/strict';
import {finishSetup} from '../src/cli.mjs';
import {createChatScreen} from '../src/setup-screen.mjs';
import { mkdtempSync, realpathSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('separate installation setup prints registration instructions without changing clients or GitHub', async () => {
 const messages=[];
 const unexpected=()=>assert.fail('Separate setup must not change client registration or GitHub credentials.');
 const result=await finishSetup(join(tmpdir(),'synthetic-self-hosted-service'),'https://swarm.example',message=>messages.push(message),true,
  {connect:unexpected,execute:unexpected,signIn:unexpected});
 assert.equal(result,0);
 assert.match(messages.join('\n'),/separate installation/);
 // Each argument is quoted for this platform's shell, so match across the quotes.
 assert.match(messages.join('\n'),/mcp-config\W+--client\W+claude\W+--state-dir/);
});

function github(t, keyring = false) {
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'minions-setup-gh-'))), file=join(directory,'hosts.yml');
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let migrated=!keyring;
 if(migrated)writeFileSync(file,'synthetic private config\n',{mode:0o600});
 const calls=[];
 return {calls,githubStorage:{envSource:{GH_CONFIG_DIR:directory}},execute:(_binary,args,options)=>{
  calls.push({args,input:options?.input});
  if(args.includes('--json'))return JSON.stringify({hosts:{'github.com':[{state:'success',active:true,host:'github.com',login:'synthetic-user',tokenSource:migrated?file:'keyring'}]}});
  if(args.includes('token'))return 'synthetic-token\n';
  if(args.includes('--with-token')){writeFileSync(file,'synthetic private config\n',{mode:0o600});migrated=true;}
  return '';
 }};
}

test('setup moves a keychain sign-in into gh\'s file, passing the token only on stdin',async t=>{
 const fixture=github(t,true),{calls}=fixture,messages=[];
 await finishSetup('/tmp/synthetic','https://example.test',()=>{},false,{...fixture,screen:createChatScreen(message=>messages.push(message)),connect:()=>[{client:'Claude Code',connected:true}]});
 const login=calls.find(call=>call.args.includes('--with-token'));
 assert.ok(login.args.includes('--insecure-storage'));assert.equal(login.input,'synthetic-token');
 assert.ok(calls.every(call=>!call.args.join(' ').includes('synthetic-token')));
 assert.doesNotMatch(messages.join('\n'),/synthetic-token/);
});

test('working GitHub alone never claims setup is ready without a connected coding client',async t=>{
 for(const clients of [[],[{client:'Codex',connected:false,note:'read-only settings'}]]){
  const fixture=github(t),messages=[];
  await finishSetup('/tmp/synthetic','https://example.test',()=>{},false,{...fixture,screen:createChatScreen(message=>messages.push(message)),connect:()=>clients});
  assert.match(messages.join('\n'),/Finish connecting a coding agent/);
  assert.doesNotMatch(messages.join('\n'),/Minions is ready/);
 }
});

test('unsafe GitHub storage refuses initial insecure login before any credential can be persisted',async t=>{
 const fixture=github(t),checkout=join(fixture.githubStorage.envSource.GH_CONFIG_DIR,'checkout');
 mkdirSync(join(checkout,'.git'),{recursive:true});
 let signIns=0;
 const result=await finishSetup('/tmp/synthetic','https://example.test',()=>{},false,{...fixture,
  githubStorage:{envSource:{GH_CONFIG_DIR:join(checkout,'gh')}},screen:createChatScreen(()=>{}),connect:()=>[],
  execute:()=>{throw Object.assign(new Error('signed out'),{code:1});},signIn:async()=>{signIns++;return true;}});
 assert.equal(result,1);assert.equal(signIns,0);
});

test('an unsafe existing GitHub file explains storage repair rather than suggesting a CLI upgrade',async t=>{
 const fixture=github(t,true),checkout=join(fixture.githubStorage.envSource.GH_CONFIG_DIR,'checkout'),messages=[];
 mkdirSync(join(checkout,'.git'),{recursive:true});
 await finishSetup('/tmp/synthetic','https://example.test',()=>{},false,{...fixture,
  githubStorage:{envSource:{GH_CONFIG_DIR:join(checkout,'gh')}},screen:createChatScreen(message=>messages.push(message)),connect:()=>[]});
 assert.match(messages.join('\n'),/private storage outside a checkout.*safe GH_CONFIG_DIR/s);
 assert.doesNotMatch(messages.join('\n'),/Update the GitHub CLI|synthetic-token/);
 assert.equal(fixture.calls.some(call=>call.args.includes('--with-token')),false);
});
