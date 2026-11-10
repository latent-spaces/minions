import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as filesystem from 'node:fs';
import { userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import { isGithubRepositoryUrl } from '../github-repository.mjs';
const execute = promisify(execFile);

const storageFailure = (message = 'GitHub file sign-in needs private, user-owned storage outside a checkout, without symbolic links. Choose a safe GH_CONFIG_DIR and try again.') => Object.assign(new Error(message), { code: 'github_storage_unsafe' });
/** gh help environment: GH_CONFIG_DIR, then XDG_CONFIG_HOME/gh, then
 * AppData/GitHub CLI on Windows, otherwise HOME/.config/gh. Metadata checks never
 * read credentials. Windows follows the service's physical user-profile policy;
 * this is not an assertion that an ACL was inspected or permission bits apply.
 */
export function assertGitHubFileStorage({ envSource = process.env, platform = process.platform, homeDir,
  create = false, requireFile = false, fs = filesystem, uid = process.getuid, userInfoImpl = userInfo } = {}) {
  const windows = platform === 'win32', path = windows ? win32 : posix;
  let identity, identityRead = false;
  const nativeIdentity = () => {
    if (!identityRead) { identityRead = true; try { identity = userInfoImpl(); } catch { identity = null; } }
    return identity;
  };
  homeDir ??= nativeIdentity()?.homedir;
  let currentUid;
  if (!windows) {
    try { currentUid = typeof uid === 'function' ? uid() : undefined; } catch {}
    if (!Number.isSafeInteger(currentUid) || currentUid < 0) currentUid = nativeIdentity()?.uid;
    if (!Number.isSafeInteger(currentUid) || currentUid < 0) throw storageFailure('GitHub file storage cannot verify POSIX ownership: native user identity is unavailable.');
  }
  const value = name => windows ? Object.entries(envSource).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1] : envSource[name];
  if (!value('GH_CONFIG_DIR') && !value('XDG_CONFIG_HOME') && !(windows && value('APPDATA')) && typeof (value('HOME') || homeDir) !== 'string') throw storageFailure();
  const config = value('GH_CONFIG_DIR') || (value('XDG_CONFIG_HOME') ? path.join(value('XDG_CONFIG_HOME'), 'gh')
    : windows && value('APPDATA') ? path.join(value('APPDATA'), 'GitHub CLI') : path.join(value('HOME') || homeDir, '.config', 'gh'));
  if (typeof config !== 'string' || !path.isAbsolute(config) || config.includes('\0')) throw storageFailure();
  const directory = path.normalize(config), file = path.join(directory, 'hosts.yml');
  const stat = target => { try { return fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return null; throw storageFailure(); } };
  const physical = windows ? fs.realpathSync?.native : fs.realpathSync;
  if (typeof physical !== 'function' || (!windows && typeof fs.constants?.O_NOFOLLOW !== 'number')) throw storageFailure();
  // Check the spelling before resolving it: resolution alone would hide a link.
  let nearest;
  for (let current = directory; ; current = path.dirname(current)) {
    const s = stat(current);
    if (s) {
      nearest ??= current;
      if (!s.isDirectory() || s.isSymbolicLink()) throw storageFailure();
      // A private leaf is insufficient under an ancestor another user can
      // rename. Root/current-user ancestors and root-owned sticky temp roots are
      // accepted; a writable non-sticky parent is never a credential location.
      if (!windows && (s.uid !== 0 && s.uid !== currentUid
        || (s.mode & 0o022) && !(s.mode & 0o1000))) throw storageFailure();
    }
    if (stat(path.join(current, '.git'))) throw storageFailure();
    if (path.dirname(current) === current) break;
  }
  if (windows) {
    if (typeof homeDir !== 'string' || !path.isAbsolute(homeDir) || !nearest) throw storageFailure();
    let profile, ancestor;
    try { profile = physical(homeDir); ancestor = physical(nearest); } catch { throw storageFailure(); }
    const relative = path.relative(profile, ancestor);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || path.relative(profile, directory) === '') throw storageFailure();
  }
  if (create) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // A concurrent creator must not introduce an unverified intermediate path.
    return assertGitHubFileStorage({ envSource, platform, homeDir, create: false, requireFile, fs, uid, userInfoImpl });
  }
  const dir = stat(directory);
  if (!dir || !dir.isDirectory() || dir.isSymbolicLink()
    || (!windows && ((dir.mode & 0o022) || dir.uid !== currentUid))) throw storageFailure();
  const current = stat(file);
  if (!current) { if (requireFile) throw storageFailure(); return file; }
  const valid = s => s.isFile() && !s.isSymbolicLink() && s.nlink === 1
    && (windows || (s.mode & 0o777) === 0o600 && s.uid === currentUid);
  if (!valid(current)) throw storageFailure();
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (windows ? 0 : fs.constants.O_NOFOLLOW));
    const opened = fs.fstatSync(fd);
    if (!valid(opened) || opened.dev !== current.dev || opened.ino !== current.ino) throw storageFailure();
  } catch { throw storageFailure(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return file;
}

// The probe and clone must see exactly the same credentials, profile and network.
// Use gh's existing approved login for Git too, without rewriting global Git config.
export function repositoryEnvironment(source = process.env) {
  const values = new Map(Object.entries(source).filter(([,v]) => typeof v === 'string').map(([k,v]) => [k.toUpperCase(),v]));
  const env = Object.fromEntries(['PATH','PATHEXT','HOME','USER','TMPDIR','TMP','TEMP','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','XDG_CONFIG_HOME','GH_CONFIG_DIR','GH_TOKEN','GITHUB_TOKEN','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR','GIT_SSL_CAINFO','GIT_SSL_CAPATH'].filter(k => values.has(k.toUpperCase())).map(k => [k,values.get(k.toUpperCase())]));
  return {...env, LC_ALL:'C', GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'Never', GH_PROMPT_DISABLED:'1'};
}
// The gh sign-in in a credential store (the macOS keychain, a Linux Secret Service, Windows Credential Manager)
// can be out of reach of agents working on their own, so gh keeps it in its own file, readable only by this
// user account, on every computer (owner decision, 27 October 2026). run(args, input) runs gh and returns stdout.
export const GITHUB_LOGIN = ['auth','login','--hostname','github.com','--git-protocol','https','--insecure-storage'];
export async function keepGitHubLoginInFile(run, storage = {}) {
  const unavailable = () => Object.assign(new Error('GitHub sign-in could not be verified for this account. Connect GitHub again.'), { code: 'github_auth_unavailable' });
  const active = async () => {
    let entry;
    try { entry = JSON.parse(await run(['auth','status','--active','--hostname','github.com','--json','hosts'])).hosts?.['github.com']?.[0]; }
    catch (error) { const failure = unavailable(); if (error?.code === 'ENOENT') failure.code = 'ENOENT'; throw failure; }
    // --json exits zero even when the credential is invalid or the check timed out.
    if (entry?.state !== 'success' || entry.active !== true || entry.host !== 'github.com'
      || typeof entry.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(entry.login)) throw unavailable();
    return entry;
  };
  const before = await active();
  // Explicit environment credentials already serve the probe and Git. Never
  // persist those ephemeral tokens or claim they were moved out of a keyring.
  if (['GH_TOKEN', 'GITHUB_TOKEN'].includes(before.tokenSource)) return;
  const file = assertGitHubFileStorage(storage), path = (storage.platform ?? process.platform) === 'win32' ? win32 : posix;
  const sameFile = value => typeof value === 'string' && path.isAbsolute(value)
    && ((storage.platform ?? process.platform) === 'win32' ? path.normalize(value).toLowerCase() === file.toLowerCase() : path.normalize(value) === file);
  if (before.tokenSource !== 'keyring') {
    if (!sameFile(before.tokenSource)) throw unavailable();
    assertGitHubFileStorage({ ...storage, requireFile: true }); return;
  }
  let token;
  try { token = await run(['auth','token','--hostname','github.com','--user',before.login]); }
  catch { throw unavailable(); }
  if (typeof token !== 'string' || !token.trim() || token.trim().length > 4096 || /[\r\n]/.test(token.trim())) throw unavailable();
  try { await run([...GITHUB_LOGIN,'--with-token'], token.trim()); } catch { throw unavailable(); }
  const after = await active();
  if (after.login.toLowerCase() !== before.login.toLowerCase() || !sameFile(after.tokenSource)) throw unavailable();
  assertGitHubFileStorage({ ...storage, requireFile: true });
}
export const canonicalRepository = isGithubRepositoryUrl;
export function createRepositoryGit({run = execute, envSource = process.env} = {}) {
  return async (args, signal, timeout = 120000) => (await run('git',[
    '-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','protocol.ext.allow=never','-c','protocol.ssh.allow=never',
    // Reset inherited helpers for this one host, then select gh. No token is in argv.
    '-c','credential.https://github.com.helper=','-c','credential.https://github.com.helper=!gh auth git-credential',
    ...args,
  ],{signal,encoding:'utf8',timeout,maxBuffer:65536,windowsHide:true,env:repositoryEnvironment(envSource)})).stdout.trim();
}
export function repositoryFailure(error) {
  const message = String(error?.stderr ?? '');
  if (error?.code === 'ENOENT') return 'git_missing';
  if (error?.code === 2) return 'empty_repository';
  if (error?.killed || error?.code === 'ETIMEDOUT' || /timed? out|timeout/i.test(message)) return 'network_timeout';
  if (/could not resolve (?:host|proxy)|name or service not known|nodename nor servname/i.test(message)) return 'dns_failed';
  if (/certificate|SSL|TLS/i.test(message)) return 'tls_failed';
  if (/could not read (?:Username|Password)|authentication failed|invalid username or (?:password|token)|terminal prompts disabled|not logged into|gh auth login/i.test(message)) return 'git_authentication_failed';
  if (/repository not found|access denied|permission denied|403|404/i.test(message)) return 'repository_access_denied';
  return 'git_failed';
}
export async function inspectRepository(repo, {git = createRepositoryGit(), signal, now = Date.now} = {}) {
  const checkedAt = now();
  if (!canonicalRepository(repo)) return {waitingFor:'github',code:'invalid_repository',checkedAt};
  try { await git(['ls-remote','--exit-code','--',repo,'HEAD'],signal); return {waitingFor:null,code:'ready',checkedAt}; }
  catch(error) { if(signal?.aborted && signal.reason?.name!=='TimeoutError') throw error; const code = signal?.reason?.name==='TimeoutError'?'network_timeout':repositoryFailure(error); return {waitingFor:code === 'empty_repository' ? 'empty_repository' : 'github',code,checkedAt}; }
}
