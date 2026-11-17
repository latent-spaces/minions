import { syncMergePolicies } from './merge-policy-sync.mjs';
// Website delivery uses the existing controller as the sole execution writer.
// Cloud requests never choose paths, binaries or credentials. An old service
// incarnation may reconcile evidence, but cannot newly submit an unfinished start.
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { ensureHome, lstatExists, readPrivate, writePrivate, physicalPath } from '../state.mjs';
import { createProvider } from '../../runtime/providers.mjs';
import { VERSION } from '../version.mjs';
import { probeWindowsSupervision } from '../windows-supervision.mjs';
import { resolveWindowsCommand } from '../windows-command.mjs';
import { repositoryEnvironment, createRepositoryGit, canonicalRepository, inspectRepository, keepGitHubLoginInFile } from './repository-access.mjs';
import { canonicalGithubRepo } from '../github-repository.mjs';

const execute = promisify(execFile);
const execution = z.object({provider:z.enum(['codex','claude']),model:z.string().regex(/^[A-Za-z0-9_:.-]{1,150}$/).nullable()}).strict();
const requestSchema = z.object({id:z.uuid(),projectId:z.string().regex(/^[a-f0-9]{64}$/),
  name:z.string().regex(/^[\w-]{1,64}$/),scope:z.string().min(1).max(8000).refine(v=>Buffer.byteLength(v)<=8000&&!v.includes('\0')),
  execution,incarnation:z.uuid().nullable(),
  state:z.enum(['pending','accepted','starting','working','failed','expired','recovery_required']),
  createdAt:z.number().int().positive(),pickupByAt:z.number().int().positive(),launchByAt:z.number().int().positive().nullable(),deadlineAt:z.number().int().positive().nullable(),agentId:z.string().regex(/^[\w-]{1,200}$/).nullable(),
});
const terminal = new Set(['working','failed','expired','recovery_required']);
const fingerprint = r => createHash('sha256').update(JSON.stringify([r.id,r.projectId,r.name,r.scope,r.execution,r.createdAt,r.pickupByAt])).digest('hex');
const failure = code => Object.assign(new Error(code),{code});
// What a failed start keeps for diagnosis, in its saved intent and service.log: the step, a code and a short message,
// never a credential. Error messages here are our own or a command's, which can name a URL but not a token.
const safeText = value => String(value ?? '').replace(/\/\/[^/\s:@]+:[^/\s@]+@/g,'//[redacted]@')
  .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g,'[redacted]').replace(/\b[a-f0-9]{64}\b/g,'[redacted]').replace(/\bsk-[A-Za-z0-9_-]{16,}/g,'[redacted]')
  .replace(/\b(Bearer|token)\s+\S+/gi,'$1 [redacted]').replace(/[\x00-\x1f\x7f-\x9f]+/g,' ').trim().slice(0,300);
export const startFailure = (step, error, at) => ({ step,
  code: typeof error?.code === 'string' && /^[A-Za-z][\w-]{0,63}$/.test(error.code) ? error.code : error?.name === 'TimeoutError' ? 'timeout' : 'error',
  message: safeText(error?.message) || 'No message.', at });
// A probe this recent describes this computer well enough for a launch; a burst of starts shares one.
const PROBE_REUSE_MS = 15_000;

export async function probeWebProviders({folder,signal,platform=process.platform,executables={codex:'codex',claude:'claude'},envSource=process.env}={}) {
  const supported=['darwin','linux','win32'].includes(platform);
  let gitAvailable=supported;
  if(supported)try{
    if(platform==='win32')await probeWindowsSupervision({env:repositoryEnvironment(envSource),signal});
    await execute('git',['--version'],{signal,encoding:'utf8',timeout:5000,maxBuffer:8192,env:repositoryEnvironment(envSource),windowsHide:true});
  }catch{gitAvailable=false;}
  return Promise.all(['codex','claude'].map(async id=>{
    if(!supported)return {id,available:false,reason:'unsupported_platform'};
    const customEndpoint=id==='claude'?envSource.ANTHROPIC_BASE_URL:envSource.OPENAI_BASE_URL;
    if(!gitAvailable||customEndpoint&&(()=>{try{return new URL(customEndpoint).origin!==(id==='claude'?'https://api.anthropic.com':'https://api.openai.com');}catch{return true;}})())return {id,available:false,reason:'unavailable'};
    try {
      const provider=createProvider(id,{codex:executables.codex,claude:executables.claude,repoDir:folder,permissionMode:'acceptEdits',turnBudgetUsd:0,passEnv:''},{envSource});
      await provider.preflight({signal});
      if(id==='claude') {
        const command=platform==='win32'?resolveWindowsCommand(executables.claude,['auth','status','--json'],{env:provider.environment(),cwd:folder}):{command:executables.claude,args:['auth','status','--json']};
        const value=await execute(command.command,command.args,{signal,encoding:'utf8',timeout:8000,maxBuffer:65536,env:provider.environment(),windowsHide:true});
        if(JSON.parse(value.stdout)?.loggedIn!==true)throw failure('provider_unavailable');
      }
      return {id,available:true,reason:'ready'};
    }catch{return {id,available:false,reason:'unavailable'};}
  }));
}

const git = createRepositoryGit();
const ghEnv = () => repositoryEnvironment();
const gh=async(args,signal)=>(await execute('gh',args,{signal,encoding:'utf8',timeout:10000,maxBuffer:262144,env:ghEnv(),windowsHide:true})).stdout.trim();
// Whether gh on this computer is signed in to github.com, for the website's Connect GitHub step (owner, 22 October 2026).
// gh auth token reads only the local sign-in. A sign-in left in a credential store moves to gh's file here, so
// computers set up before that rule get it too; one that can't move stays signed out until Connect GitHub.
export async function githubSignInOf(signal, { executeImpl = execFile, envSource = process.env, storage = {} } = {}) {
  const env = repositoryEnvironment(envSource);
  const options={signal,encoding:'utf8',timeout:10000,maxBuffer:65536,env,windowsHide:true};
  const run=(args,input)=>new Promise((resolve,reject)=>{
    const fail=error=>reject(Object.assign(new Error('GitHub sign-in could not be verified.'),{code:error?.code==='ENOENT'?'ENOENT':'github_command_failed'}));
    try{
      const child=executeImpl('gh',args,options,(error,stdout)=>error?fail(error):resolve(stdout));
      // gh can exit before reading a token. EPIPE belongs to the stdin stream,
      // not just execFile's completion callback; never leave it unhandled.
      child.stdin?.on('error',fail);
      if(input!==undefined&&!child.stdin){fail();return;}
      child.stdin?.end(input);
    }catch(error){fail(error);}
  });
  try{await keepGitHubLoginInFile(run,{...storage,envSource:env});return 'ready';}
  catch(error){if(signal?.aborted)throw signal.reason??error;return error?.code==='ENOENT'?'missing':'signed_out';}
}
const GITHUB_USERNAME=/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const canonicalRepo = canonicalRepository;
const repoKey=canonicalGithubRepo;
// With this computer's gh sign-in (owner decision, 22 October 2026): adds the members of the person's own projects who
// aren't collaborators or invited yet, and accepts the invitations to exactly the repositories of projects they joined.
export async function syncRepositoryAccess({owned,joined},{signal}={}) {
  const quietly=async work=>{try{await work();}catch(error){if(signal?.aborted)throw error;}};
  for(const {repo,usernames} of owned)if(canonicalRepo(repo))await quietly(async()=>{
    const path=`repos/${new URL(repoKey(repo)).pathname.slice(1)}`;
    const known=(await Promise.all([gh(['api','--paginate',`${path}/collaborators`,'--jq','.[].login'],signal),gh(['api','--paginate',`${path}/invitations`,'--jq','.[].invitee.login'],signal)])).join('\n').toLowerCase().split('\n');
    for(const name of usernames)if(GITHUB_USERNAME.test(name)&&!known.includes(name.toLowerCase()))await gh(['api','--method','PUT',`${path}/collaborators/${name}`,'-f','permission=push'],signal);
  });
  const wanted=joined.filter(canonicalRepo).map(repoKey);
  if(wanted.length)await quietly(async()=>{
    for(const [id,url] of (await gh(['api','--paginate','user/repository_invitations','--jq','.[] | [.id, .repository.html_url] | @tsv'],signal)).split('\n').map(line=>line.split('\t')))
      if(url&&wanted.includes(repoKey(url)))await gh(['api','--method','PATCH',`user/repository_invitations/${id}`],signal);
  });
}
// What a start still waits for at the project's repository: null when this computer can reach it and it has a commit
// to work from, 'github' without access, 'empty_repository' when it is reachable but empty. git ls-remote --exit-code
// exits 2 for a reachable repository without HEAD and 128 for one it can't reach.
async function repositoryWaitOf(record, options = {}) {
  return inspectRepository(record.repo, options);
}

const CLONE_MS=30*60_000;
export async function prepareWebCheckout(record,{signal}={}) {
  // The private owner client allocated this exact folder for this new request.
  const folder=record.folder,stat=lstatSync(folder);
  if(!stat.isDirectory()||stat.isSymbolicLink()||process.getuid&&stat.uid!==process.getuid()||physicalPath(folder)!==folder)
    throw failure('preparation_failed');
  if(!canonicalRepo(record.repo))throw failure('preparation_failed');
  if(!readdirSync(folder).length){
    // A large repository takes longer than the other git commands' two minutes; the caller's signal bounds it.
    await git(['clone','--no-recurse-submodules','--template=','--',record.repo,folder],signal,0);
  }
  // A lost local response can reuse only this request's fully prepared checkout.
  // Partial clones are preserved for inspection, never deleted or overwritten.
  const [root,origin]=await Promise.all([git(['-C',folder,'rev-parse','--show-toplevel'],signal),git(['-C',folder,'remote','get-url','origin'],signal)]);
  if(physicalPath(root)!==folder||repoKey(origin)!==repoKey(record.repo))throw failure('preparation_failed');
}

export function createWebAgentStarts({home,principal,ownerClient,controllers,addAgent,capabilities,prepareCheckout=prepareWebCheckout,repositoryWait=repositoryWaitOf,githubSignIn=githubSignInOf,syncAccess=syncRepositoryAccess,intervalMs=15000,now=Date.now,incarnation=randomUUID(),platform=process.platform,log=message=>console.error(message)}) {
  const directory=join(home,'web-starts');ensureHome(directory);
  const abort=new AbortController(),jobs=new Map(),early=new Set(),accessChecks=new Map();let closed=false,polling,cached,checkedAt=0,github,sharing,sharedAt=0;
  let cloud = {state:'unknown',lastSuccessAt:null,lastAttemptAt:null};
  const options=signal=>({signal,expectedProfileId:principal.ownerId});
  const capabilityProbe=capabilities??(signal=>probeWebProviders({folder:home,signal,platform}));
  const pathFor=id=>join(directory,`${id}.json`);
  const read=id=>lstatExists(pathFor(id))?readPrivate(pathFor(id),true):null;
  const save=intent=>writePrivate(pathFor(intent.request.id),intent);
  // Each probe runs several client commands. Concurrent callers share one, so a burst of starts does not start
  // dozens of processes at once and push every start past its timeouts.
  let probing=null;
  async function providers(force=false,signal=abort.signal) {
    if(force&&cached&&now()-checkedAt<PROBE_REUSE_MS)force=false;
    if(force||!cached||now()-checkedAt>=60000){
      // The shared probe has its own bound, so one caller's timeout does not fail the others waiting on it.
      if(!probing){const shared=AbortSignal.any([abort.signal,AbortSignal.timeout(30000)]);
        probing=Promise.all([capabilityProbe(shared),githubSignIn(shared)]).then(([value,signedIn])=>{cached=value;github=signedIn;checkedAt=now();}).finally(()=>{probing=null;});}
      signal.throwIfAborted();
      await Promise.race([probing,new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);
    }
    return cached;
  }
  // Launches take turns: each prepares, confirms and hands its start to the controllers before the next begins.
  // A start waiting here is still bounded by its own launch window.
  let launching=Promise.resolve();
  const inTurn=work=>{const turn=launching.then(work);launching=turn.catch(()=>{});return turn;};
  async function acknowledge(intent,receipt) {
    const ack=await ownerClient.acknowledgeAgentStart(intent.request.id,{incarnation:intent.request.incarnation,...receipt},options(abort.signal));
    if(ack?.ok!==true)throw failure('receipt_unavailable');
  }
  async function missionReceipt(intent) {
    if(!intent.command)return null;
    let mission;
    try{mission=await controllers.getMission({missionId:intent.command.missionId,target:intent.command.target});}
    catch(error){if(error?.code==='not_found')return null;throw error;}
    if(!mission)return null;
    if(mission.currentTurnStage==='applied'||mission.outcomes?.some(row=>row.outcome?.delivery==='acknowledged'))return {state:'working',agentId:intent.command.target.agentId};
    if(mission.state==='recovery_required')return {state:'recovery_required',agentId:intent.command.target.agentId,code:'recovery_required'};
    if(['failed','stopped','blocked'].includes(mission.state))return {state:'failed',agentId:intent.command.target.agentId,code:'launch_failed'};
    // Started after the job's end time: it is up and waits for more time, so it has not missed its launch.
    if(mission.deadlineAt<=now())return {state:'working',agentId:intent.command.target.agentId};
    // A run that never took its first turn in its launch window has expired; say so instead of starting forever.
    if(now()>=intent.request.launchByAt)return {state:'expired',agentId:intent.command.target.agentId,code:'request_expired'};
    return {state:'starting',agentId:intent.command.target.agentId};
  }
  async function reconcile(intent) {
    const receipt=await missionReceipt(intent);
    if(receipt){await acknowledge(intent,receipt);return true;}
    return false;
  }
  // A start without access to the repository waits for it instead of failing, and checks again about once a minute
  // while the owner's computer adds the person and this one accepts their invitation. A reachable but empty
  // repository waits the same way for its first commit: agents branch from and open pull requests against it.
  async function waitForRepository(request,registered) {
    const last=accessChecks.get(request.id);
    if(last&&now()-last<60000)return false;
    let record=registered;
    if(!record&&request.agentId){
      ({record}=await addAgent({project_id:request.projectId,agent_name:request.name},'Minions website',{expectedProfileId:principal.ownerId,exact:request.agentId}));
      if(record.agentId!==request.agentId||record.ownerProfileId!==principal.ownerId||record.agentName!==request.name)throw failure('preparation_failed');
    }
    // Without a folder yet, the checkout itself reports any missing access at launch.
    if(!record?.folder)return true;
    const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(60000)]);
    const repository=await repositoryWait(record,{signal});
    if(!repository.waitingFor){
      // Clone while the start waits, before the three-minute launch window: a large repository takes longer.
      // A failed clone is tried again at the next check, about a minute later.
      accessChecks.set(request.id,now());
      await prepareCheckout(record,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(CLONE_MS)])});
      accessChecks.delete(request.id);return true;
    }
    accessChecks.set(request.id,now());
    await ownerClient.acceptAgentStart(request.id,{incarnation,waitingFor:repository.waitingFor,repository},options(AbortSignal.any([abort.signal,AbortSignal.timeout(12000)])));
    return false;
  }
  async function processRequest(raw) {
    const request=requestSchema.parse(raw);let intent=read(request.id);
    if(intent&&intent.fingerprint!==fingerprint(request))throw failure('request_conflict');
    if(intent?.receipt){await acknowledge(intent,intent.receipt);return;}
    if(intent&&await reconcile(intent))return;
    if(request.state==='recovery_required'){
      intent??={request,fingerprint:fingerprint(request),boot:incarnation};
      intent.receipt={state:'recovery_required',...(request.agentId?{agentId:request.agentId}:{}),code:'recovery_required'};save(intent);await acknowledge(intent,intent.receipt);return;
    }
    // A restart never allocates, clones or submits a previously accepted request.
    if(request.incarnation!==null&&request.incarnation!==incarnation||intent&&intent.boot!==incarnation) {
      intent??={request,fingerprint:fingerprint(request),boot:incarnation};
      intent.receipt={state:'recovery_required',code:'recovery_required'};save(intent);await acknowledge(intent,intent.receipt);return;
    }
    if(now()>=request.pickupByAt&&request.state==='pending')return;
    // A new agent is created as soon as it is added, like one added from a coding agent; its start waits for the project.
    // If that fails (a taken name, the agent limit), it is tried once more at launch, which reports the failure.
    let registered=null;
    if(request.state==='pending'&&request.agentId===null&&!early.has(request.id)){
      early.add(request.id);
      ({record:registered}=await addAgent({project_id:request.projectId,agent_name:request.name},'Minions website',{expectedProfileId:principal.ownerId,webStartId:request.id}));
      if(registered.webStartId!==request.id||registered.ownerProfileId!==principal.ownerId||registered.agentName!==request.name||registered.service!==`${principal.site}/p/${request.projectId}`)throw failure('preparation_failed');
    }
    if(request.state==='pending'&&!await waitForRepository(request,registered))return;
    const accepted=await ownerClient.acceptAgentStart(request.id,{incarnation},options(abort.signal));
    const grant=requestSchema.parse(accepted?.request);
    if(fingerprint(grant)!==fingerprint(request))throw failure('request_conflict');
    if(!['accepted','starting'].includes(grant.state)||!grant.launchByAt||!grant.deadlineAt)return;
    if(intent&&(intent.request.launchByAt!==grant.launchByAt||intent.request.deadlineAt!==grant.deadlineAt))throw failure('request_conflict');
    intent??={request:grant,fingerprint:fingerprint(grant),boot:incarnation};save(intent);
    // Only the launch window bounds preparation. A start that finishes after the job's end time comes up waiting for more time.
    const live=()=>{abort.signal.throwIfAborted();if(now()>=grant.launchByAt)throw failure('request_expired');};
    const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(Math.max(1,grant.launchByAt-now()))]);
    let step='waiting for its turn';
    try { await inTurn(async()=>{
      live();
      step='checking providers';
      const available=await providers(true,signal);
      if(!available.some(p=>p.id===grant.execution.provider&&p.available))throw failure('provider_unavailable');
      live();
      step='adding the agent';
      // A run for an agent that already exists reuses its connection and folder; otherwise the web start creates it.
      const existing=intent.request.agentId??grant.agentId??registered?.agentId;
      const added=registered?{record:registered}:await addAgent({project_id:grant.projectId,agent_name:grant.name},'Minions website',{expectedProfileId:principal.ownerId,...(existing?{exact:existing}:{webStartId:grant.id})});
      const record=added.record;
      if((existing?record.agentId!==existing:record.webStartId!==grant.id)||record.ownerProfileId!==principal.ownerId||record.agentName!==grant.name||record.service!==`${principal.site}/p/${grant.projectId}`)throw failure('preparation_failed');
      intent.agentId=record.agentId;save(intent);
      // Progress for the website only; the confirmation below is what authorizes the launch.
      step='reporting progress';
      await acknowledge(intent,{state:'starting',agentId:record.agentId}).catch(error=>log(`Minions website start ${grant.id}: progress report not delivered (${startFailure(step,error).code}); continuing.`));
      step='preparing the checkout';
      live();await prepareCheckout(record,{signal});live();
      step='confirming the start';
      // Refresh cloud authorization after preparation. Expired/revoked requests
      // cannot turn a completed clone into newly authorized execution.
      const confirmed=await ownerClient.acceptAgentStart(grant.id,{incarnation},options(signal));
      if(confirmed?.request?.state!=='accepted'&&confirmed?.request?.state!=='starting')throw failure('request_expired');
      live();
      intent.command={version:2,operationId:grant.id,missionId:grant.id,kind:'start',target:{...principal,projectId:grant.projectId,agentId:record.agentId},
        payload:{scope:grant.scope,deadlineAt:grant.deadlineAt,execution:grant.execution}};
      save(intent); // Immutable command exists before the sole execution writer.
      step='handing the start to its agent';
      await controllers.accept(intent.command);
    }); step='reporting the start'; await reconcile(intent);
    }catch(error){
      intent.failure=startFailure(step,error,now());save(intent);
      log(`Minions website start ${grant.id} failed while ${step}: ${intent.failure.code}: ${intent.failure.message}`);
      // A lost acceptance reply is not evidence that execution failed.
      if(intent.command&&await reconcile(intent))return;
      if(intent.command){intent.receipt={state:'recovery_required',agentId:intent.agentId,code:'recovery_required'};}
      else intent.receipt={state:now()>=grant.launchByAt?'expired':'failed',...(intent.agentId?{agentId:intent.agentId}:{}),
        code:now()>=grant.launchByAt?'request_expired':error?.code==='provider_unavailable'?error.code:'preparation_failed'};
      save(intent);await acknowledge(intent,intent.receipt);
    }
  }
  function poll(){
    if(closed)return Promise.resolve();if(polling)return polling;
    polling=(async()=>{
      const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(12000)]);
      const choices=await providers(false,signal);
      cloud = {...cloud,lastAttemptAt:now()};
      try { await ownerClient.publishRuntimeReadiness({protocol:1,version:VERSION,incarnation,platform,providers:choices,github},options(signal)); }
      catch(error) { cloud={...cloud,state:'unavailable'};throw error; }
      cloud = {state:'connected',lastSuccessAt:now(),lastAttemptAt:now()};
      // Repository access is brought up to date about once a minute, beside the starts.
      if(github==='ready'&&!sharing&&now()-sharedAt>=60000){sharedAt=now();
        sharing=ownerClient.listRepositoryAccess(options(abort.signal)).then(async value=>{await syncAccess(value,{signal:abort.signal});await syncMergePolicies(value,{ownerClient,options,signal:abort.signal});}).catch(()=>{}).finally(()=>{sharing=null;});}
      const value=await ownerClient.listAgentStarts(options(signal));
      if(!Array.isArray(value?.requests)||value.requests.length>32||!Number.isSafeInteger(value.serverTime))throw failure('invalid_reply');
      // Execution relies on wall-clock deadlines throughout the existing runtime.
      // Refuse fresh starts if the machine clock is clearly out of sync.
      const skew=Math.abs(value.serverTime-now())>30000;
      for(const raw of value.requests){
        const parsed=requestSchema.safeParse(raw);if(!parsed.success||terminal.has(parsed.data.state)&&parsed.data.state!=='recovery_required'||jobs.has(parsed.data.id))continue;
        if(skew)continue;
        // Failures before a launch (adding the agent, the repository check, acceptance) are retried at a later poll.
        const job=processRequest(parsed.data).catch(error=>{const reason=startFailure('preparing',error);log(`Minions website start ${parsed.data.id} will retry: ${reason.code}: ${reason.message}`);}).finally(()=>jobs.delete(parsed.data.id));jobs.set(parsed.data.id,job);
      }
    })().finally(()=>{polling=null;});return polling;
  }
  const timer=setInterval(()=>{void poll().catch(()=>{});},intervalMs);timer.unref?.();
  void poll().catch(()=>{});
  return {poll, status() { return {...cloud,state:cloud.state==='connected'&&now()-cloud.lastSuccessAt>45000?'stale':cloud.state}; }, async close(){closed=true;clearInterval(timer);abort.abort();await Promise.allSettled([polling,sharing,...jobs.values()]);}};
}
