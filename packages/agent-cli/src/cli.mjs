#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRuntimeClient } from './service/local-client.mjs';
import { VERSION } from './version.mjs';
import { commandSchema, recoverySchema } from './service/runtime-tools.mjs';
import { sessionHome } from './session.mjs';
import { connectorCommand } from './connector-command.mjs';
import { configuredWebsiteOrigin, selfHostedWebsiteOrigin } from './website-origin.mjs';
import { createOwnerClient } from './owner-client.mjs';
import { installationHome, readInstallation, startDetachedService, statusInstalledService, stopInstalledService, runInstalledService } from './service/installation.mjs';
import { composeInstalledRuntime } from './service/bootstrap.mjs';
import { openPage, canOpenPages } from './system.mjs';
import { reusableConfiguration, renderReusableConfiguration } from './mcp-configuration.mjs';
import { connectClients, registerWithClaudeCode } from './client-setup.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { createSetupScreen, createChatScreen } from './setup-screen.mjs';
import { GITHUB_LOGIN, keepGitHubLoginInFile, assertGitHubFileStorage } from './service/repository-access.mjs';
import { BUNDLED_SKILL, bundledGuideFiles, readBundledGuide, skillTextHash } from './skill-bundle.mjs';

export const HELP = `MyLittleSwarm MCP ${VERSION}

Connect your existing AI coding client to MyLittleSwarm projects.
Setup and current-chat mode do not choose or run a model. Your MCP client may use
Claude, Codex, DeepSeek or another model supported by that client.

Commands:
  setup [--site WEBSITE] [--wait-seconds N] [--no-client-hint]
      Connect this computer to the local MyLittleSwarm engine (waiting up to N seconds,
      default 120, for the engine to answer), start its shared local service and connect
      Claude Code and Codex to it, with the MyLittleSwarm skill. Starts no models.
      --no-client-hint: for a separate installation, leave the coding agents to the
      caller (npm run setup registers Claude Code itself).
  mcp-config --client claude|codex|other [--state-dir ABSOLUTE_PRIVATE_DIRECTORY]
      Print HTTP registration for another client; changes no client settings.
  register --client claude [--state-dir ABSOLUTE_PRIVATE_DIRECTORY]
      Register this installation's MCP server with Claude Code through its claude
      command, unless it already is. Exit 0 when registered, 4 when no claude command
      is found on PATH.
  tool --list [TOOL_NAME]
  tool TOOL_NAME ['JSON_ARGUMENTS']
      Call one of the running shared service's MCP tools, as your coding agent would,
      and print its JSON result; exit 1 when the tool reports an error. Use it until
      your coding agent is restarted and loads the MyLittleSwarm tools itself.
  service-start / service-status / service-stop
      Start, inspect or explicitly stop the shared service. Stop ends turns in progress.
  service-stop --after-turns [--wait-minutes N]
      Let the turns in progress finish, start no new one, then stop; agents continue
      in the same missions when the service starts again. Use it to update the
      connector. Waits up to 60 minutes by default.
      Native Claude/Codex clients connect over HTTP; no stdio runtime exists.
  run-log --mission UUID --project ID --agent ID
      [--after N] [--limit 1..100]
  run-diagnostics --mission UUID --project ID --agent ID
      Inspect private saved run evidence or recovery observations. Reads only;
      never releases a checkout, changes reports, restarts work or runs a model.
  run-recover --mission UUID --project ID --agent ID
      --request-id UUID --action finalize|retry_report|archive_failed_launch_report --reason TEXT --approve
      [--generation N] [--report SHA256 --attempts N --error-code CODE]
      Finalize safely interrupted work or retry its exact attention report. Starts no model.
  run-pause|run-resume --mission UUID --project ID --agent ID
      --generation N --request-id UUID --approve
      Pause an owned background worker or resume its exact Pause.
      For run-resume only: [--pause-request UUID] names that Pause.
  skill [--section projects|agents|work-in-chat|project-work|updates-and-help|computer] [--json]
      Print the router or one workflow. With no section, --json includes the full
      installable bundle in files, plus the router content, revision and hashes.
  project-overview --project PROJECT_ID
  project-configure --project PROJECT_ID --repo GITHUB_URL --revision N --request-id ID --approve
  project-card --project PROJECT_ID --definition-file ABSOLUTE_JSON --card-version N --request-id ID --approve
  project-publish --project PROJECT_ID --revision N --request-id ID --approve
      [--minimum N] [--start-date ISO_DATE]
  project-agents --project PROJECT_ID [--cursor CURSOR]
  agents-register --project PROJECT_ID --names NAME1,NAME2 --request-id ID --approve
      Sign in through browser approval for 90-day human project management.
      Management commands require the selected shared runtime to be running.
  my-projects [--scope owned|joined|all] [--cursor CURSOR]
  my-proposals [--cursor CURSOR]
  project-create-private --title NAME --goal PURPOSE --repo GITHUB_URL --request-id UUID --approve
      Create a private, chat-ready project with its repository; no proposal review.
  proposal-status --project PROJECT_ID
  project-start --project PROJECT_ID --revision N --request-id ID --approve
      [--start-without-minimum]
  All commands accept --state-dir ABSOLUTE_PRIVATE_DIRECTORY.
  No secret tokens or codes are accepted as arguments.
  --help
  --version

Run setup once on each computer. For a client other than Claude Code or Codex,
register the entry mcp-config prints. Then open a new conversation in your coding
agent and start building, or copy prompts from your configured MyLittleSwarm website into it.
Project approval happens separately in your browser. No automatic worker launch.
Optional local workers require explicit client, scope, separate folder and duration approval.
Codes and tokens are never accepted as command arguments.`;
const stateSpec = { 'state-dir': { type: 'string' } };
const runQuerySpec = { ...stateSpec, mission:{type:'string'}, project:{type:'string'}, agent:{type:'string'} };
export const specs = {
  'run-pause': {...runQuerySpec,generation:{type:'string'},'request-id':{type:'string'},approve:{type:'boolean'}},
  'run-resume': {...runQuerySpec,generation:{type:'string'},'request-id':{type:'string'},approve:{type:'boolean'},'pause-request':{type:'string'}},
  'run-log': {...runQuerySpec,after:{type:'string'},limit:{type:'string'}},
  'run-diagnostics': runQuerySpec,
  'run-recover': {...runQuerySpec,generation:{type:'string'},'request-id':{type:'string'},action:{type:'string'},reason:{type:'string'},approve:{type:'boolean'},report:{type:'string'},attempts:{type:'string'},'error-code':{type:'string'}},
  'mcp-config': { site: { type: 'string' }, client: { type: 'string' }, 'state-dir': { type: 'string' } },
  setup: {...stateSpec,site:{type:'string'},'wait-seconds':{type:'string'},'no-client-hint':{type:'boolean'}},
  register: {...stateSpec,client:{type:'string'}},
  tool: {...stateSpec,list:{type:'boolean'}},
  'service-start': {...stateSpec,site:{type:'string'}}, 'service-status':stateSpec, 'service-stop':{...stateSpec,'after-turns':{type:'boolean'},'wait-minutes':{type:'string'}}, 'service-run':stateSpec,
  'project-overview': {...stateSpec,project:{type:'string'}},
  'project-configure': {...stateSpec,project:{type:'string'},repo:{type:'string'},revision:{type:'string'},'request-id':{type:'string'},approve:{type:'boolean'}},
  'project-card': {...stateSpec,project:{type:'string'},'definition-file':{type:'string'},'card-version':{type:'string'},'request-id':{type:'string'},approve:{type:'boolean'}},
  'project-publish': {...stateSpec,project:{type:'string'},revision:{type:'string'},minimum:{type:'string'},'start-date':{type:'string'},'request-id':{type:'string'},approve:{type:'boolean'}},
  skill: { json: { type: 'boolean' }, section: { type: 'string' } },
  'project-agents': { ...stateSpec, project:{type:'string'}, cursor:{type:'string'} },
  'agents-register': { ...stateSpec, project:{type:'string'}, names:{type:'string'}, 'request-id':{type:'string'}, approve:{type:'boolean'} },
  'my-projects': { ...stateSpec, scope:{type:'string'}, cursor:{type:'string'} }, 'my-proposals': { ...stateSpec, cursor:{type:'string'} },
  'project-create-private': { ...stateSpec, title:{type:'string'}, goal:{type:'string'}, repo:{type:'string'}, 'request-id':{type:'string'}, approve:{type:'boolean'} },
  'proposal-status': { ...stateSpec, project:{type:'string'} },
  'project-start': { ...stateSpec, project:{type:'string'}, revision:{type:'string'}, 'request-id':{type:'string'}, approve:{type:'boolean'}, 'start-without-minimum':{type:'boolean'} },
};
export async function main(args, out = console.log, err = console.error) {
  if (!args.length || (args.length === 1 && ['--help', 'help', '-h'].includes(args[0]))) { out(HELP); return 0; }
  if (args.length === 1 && args[0] === '--version') { out(VERSION); return 0; }
  const [command, ...rest] = args;
  if (!Object.hasOwn(specs, command)) { err('Unknown command. Run --help for details.'); return 2; }
  try {
    let parsed;
    try { parsed = parseArgs({ args: rest, options: specs[command], allowPositionals: command === 'tool', tokens: true }); }
    catch { throw new Error('Invalid arguments. Run --help. Codes and tokens are not accepted as arguments.'); }
    const names = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name);
    if (new Set(names).size !== names.length) throw new Error('Supply each option once.');
    const values = parsed.values;
    if (values['state-dir'] && (!isAbsolute(values['state-dir']) || /[\x00-\x1f\x7f-\x9f]/.test(values['state-dir']))) throw new Error('Choose an absolute private state directory.');
    const waitSeconds = command === 'setup' ? Number(values['wait-seconds'] ?? 120) : 0;
    if (command === 'setup' && (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 600)) throw new Error('Choose --wait-seconds between 0 and 600.');
    if (command === 'skill') {
      const content = readBundledGuide(values.section);
      out(values.json ? JSON.stringify(values.section
        ? { guide_revision: BUNDLED_SKILL.guide_revision, section: values.section, sha256: skillTextHash(content), content }
        : { ...BUNDLED_SKILL, content, files: bundledGuideFiles() }, null, 2) : content);
      return 0;
    }
    if (command === 'tool') return await callServiceTool(values, parsed.positionals, out, err);
    if (command === 'register') {
      if (values.client !== 'claude') throw new Error('Choose --client claude. For Codex or another client, use mcp-config.');
      const outcome = registerWithClaudeCode({ home: values['state-dir'] ?? installationHome() });
      if (outcome.status === 'missing') { out('Claude Code’s claude command was not found on PATH, so nothing was registered.'); return 4; }
      out(outcome.status === 'current' ? `Claude Code already has MyLittleSwarm (${outcome.name}).`
        : `Registered MyLittleSwarm (${outcome.name}) with Claude Code. A new Claude Code session loads its tools.`);
      return 0;
    }
    if (command === 'mcp-config') { out(renderReusableConfiguration(reusableConfiguration({ client: values.client, home: values['state-dir'], site: values.site }))); return 0; }
    const home = values['state-dir'] ?? installationHome();
    const selectedSite = () => {
      if (values.site) {
        const enrolled = selfHostedWebsiteOrigin();
        if (enrolled && values.site !== enrolled) throw new Error('--site must match MLSWARM_SELF_HOSTED_ORIGIN. Use a separate shell configuration for another installation.');
        return values.site;
      }
      try { return readInstallation(home).site; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return configuredWebsiteOrigin();
    };
    if (['setup','service-start'].includes(command)) {
      const site = selectedSite(), owner = createOwnerClient({home:sessionHome(),site});
      // A person at a terminal sees the setup screen; a coding agent gets short lines. Under npm run setup, which shows
      // its own steps and summary (--no-client-hint), only the short lines are shown.
      const nested = values['no-client-hint'] === true;
      const screen = command !== 'setup' ? null : !nested && process.stdin.isTTY && process.stdout.isTTY ? createSetupScreen() : createChatScreen(out);
      // This computer connects to the local engine by itself; nobody approves it (owner decision, 13 November 2026).
      if (screen && !nested) { screen.start(); screen.step(1, 'Connecting this computer to MyLittleSwarm'); }
      const account = await connectWhenReady(owner, site, { seconds: waitSeconds });
      if (screen) screen.done(`This computer is connected${account.account_name ? ` for ${account.account_name}` : ''}`);
      const separate = !!(values['state-dir'] || process.env.MLSWARM_SERVICE_HOME || selfHostedWebsiteOrigin());
      // A separate installation changes no coding agent here, so there is no step 2 to show.
      if (screen && !separate) screen.step(2, 'Connecting your coding agents');
      const stop = screen?.waiting();
      let status;
      try { status = await startDetachedService({home,site,entryPoint:fileURLToPath(import.meta.url),args:['service-run']}); } finally { stop?.(); }
      if (command === 'service-start') { out(JSON.stringify(status,null,2)); return 0; }
      // Step 2's spinner covers the service starting; only the coding agents are listed.
      return await finishSetup(home, site, out, separate, { screen, clientHint: values['no-client-hint'] !== true });
    }
    if (command === 'service-status') { out(JSON.stringify(await statusInstalledService({home}),null,2));return 0; }
    if (command === 'service-stop') {
      const afterTurns = values['after-turns'] === true, minutes = values['wait-minutes'];
      if (minutes !== undefined && (!afterTurns || !/^[1-9]\d{0,3}$/.test(minutes))) throw new Error('--wait-minutes takes a whole number from 1 to 9999, with --after-turns.');
      out(JSON.stringify(await stopInstalledService({home,afterTurns,...(minutes ? {timeoutMs:Number(minutes)*60000} : {})}),null,2));return 0;
    }
    if (command === 'service-run') {
      const service = await runInstalledService({home,compose:composeInstalledRuntime});
      const stop = () => { void service.close().catch(()=>{process.exitCode=1;}); };
      process.once('SIGINT',stop);process.once('SIGTERM',stop);
      await service.closed;process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);return 0;
    }
    {
      const selected = managementCall(command, values);
      const runtime = createRuntimeClient({ home: values['state-dir'] });
      return runtime.callTool(selected.name, selected.args).then(reply => {
        if (reply.isError) throw new Error('Management could not complete through the shared runtime. Review the original request; credentials were not printed.');
        const text = reply.content?.find(item => item.type === 'text')?.text;
        const value = JSON.parse(text);
        out(JSON.stringify(value, null, 2)); return 0;
      }).catch(() => { err('Management could not complete through the selected shared runtime. Check runtime status, account authorization and the original request; no fallback or model was started.'); return 2; }).finally(() => runtime.close().catch(() => {}));
    }
  } catch (error) { err(error.message); return 2; }
}
// The person copies this command, so it names one client and quotes every path for their shell.
export function separateInstallationHint(home, platform = process.platform) {
  const command = connectorCommand(platform, { args: ['mcp-config', '--client', 'claude', '--state-dir', home] });
  return `This is a separate installation, so no coding client was changed. To register it, run this, with --client codex or --client other for those coding agents: ${command}`;
}
// Connects this computer, retrying while the local engine is still starting and cannot be reached yet.
export async function connectWhenReady(owner, site, { seconds, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const until = now() + seconds * 1000;
  for (;;) {
    try { return await owner.connect('MyLittleSwarm shared service', site); }
    catch (error) { if (!(error?.unreachable || /can’t be reached right now/.test(error.message)) || now() >= until) throw error; }
    await sleep(1000);
  }
}
// Connects the coding clients, then GitHub, which agents need for project code. Setup signs in to GitHub itself
// and shows its code, at a terminal or through the coding agent, so the agent never runs gh login commands.
// A separate installation, such as one for local testing, never replaces the clients' everyday entry.
export async function finishSetup(home, site, out, separate, {screen, clientHint = true, connect = connectClients, execute = execFileSync, signIn = signInToGitHub, githubStorage = {}}) {
  if (separate) { if (clientHint) out(separateInstallationHint(home)); return 0; }
  const results = connect({ home });
  for (const result of results) {
    if (result.connected) screen.done(`${result.client} is connected${result.note ? `; ${result.note}` : ''}`);
    else screen.problem(`${result.client} could not be connected: ${result.note}`);
  }
  if (!results.length) screen.problem(`No Claude Code or Codex found. For another coding agent, run: ${connectorCommand(process.platform, { args: ['mcp-config', '--client', 'other'] })}`);
  const gh = args => { try { execute('gh', args, { stdio: 'ignore' }); return true; } catch (error) { return error.code === 'ENOENT' ? null : false; } };
  screen.step(3, 'Connect GitHub', 'Your agents use GitHub to work on project code.');
  let github = gh(['auth', 'status', '--hostname', 'github.com']);
  // Setup's first line says it connects GitHub, and GitHub asks the person to authorize it, so there is no extra question.
  if (github === false) {
    try { assertGitHubFileStorage({ ...githubStorage, create: true }); }
    catch { screen.problem('GitHub sign-in needs a private configuration folder. Check gh configuration permissions, then run setup again.'); return 1; }
    if (await signIn(screen)) github = gh(['auth', 'status', '--hostname', 'github.com']);
  }
  if (github === true) {
    try { await keepGitHubLoginInFile((args, input) => execute('gh', args, { encoding: 'utf8', input }), githubStorage); }
    catch (error) {
      github = false;
      screen.problem(error.code === 'github_storage_unsafe'
        ? 'GitHub sign-in needs private storage outside a checkout. Choose a safe GH_CONFIG_DIR, then run setup again.'
        : error.code === 'ENOENT' ? 'The GitHub CLI (gh) is unavailable. Install it, then run setup again.'
        : 'GitHub sign-in could not be verified for this account. Connect GitHub again, then run setup again.');
    }
  }
  // An existing gh login does not imply Git has a credential helper configured.
  if (github === true && !gh(['auth', 'setup-git'])) {
    github = false;
    screen.problem('GitHub sign-in exists, but Git credential setup failed. Run gh auth setup-git before starting project work.');
  }
  if (github === true) {
    screen.done('GitHub is connected');
    if (results.some(result => result.connected)) screen.ready(`${site}/?view=projects`);
    else screen.problem('Finish connecting a coding agent before opening a new conversation.');
    return 0;
  }
  if (github === null) { screen.action({ note: 'Your agents need the GitHub CLI to work on project code. Install it, then run setup again.', label: 'Install the GitHub CLI', url: 'https://cli.github.com' }); return 0; }
  screen.problem('GitHub is not connected yet. Your agents need GitHub to work on project code. Connect it any time from the Connect GitHub step in MyLittleSwarm.');
  return 0;
}
// Shows a page to open on the setup screen. Enter opens it, as often as the person likes, until the returned
// function is called; with no desktop to open it on, the address alone is shown.
function offerPage(screen, { label, url, onInterrupt, ...rest }) {
  if (!screen.interactive || !canOpenPages()) { screen.action({ ...rest, label: `Open ${label}`, url }); return () => {}; }
  screen.action({ ...rest, label: `Press Enter to open ${label}`, url });
  return screen.onEnter(() => openPage(url), onInterrupt);
}
// gh's browser sign-in, shown on the setup screen or passed on by the agent: gh prints its code and page when its output isn't a terminal,
// then waits for the person to authorize. Resolves whether gh finished signing in.
export function signInToGitHub(screen, { spawnImpl = spawn, processImpl = process, offer = offerPage } = {}) {
  return new Promise(resolve => {
    const child = spawnImpl('gh', [...GITHUB_LOGIN, '--web'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let text = '', bytes = 0, stop = null, settled = false;
    const onInterrupt = signal => {
      if (settled) return;
      try { child.kill('SIGTERM'); } catch {}
      finish(false);
      // Restore the normal parent signal after its owned login has been stopped.
      processImpl.kill(processImpl.pid, signal);
    };
    const onInt = () => onInterrupt('SIGINT'), onTerm = () => onInterrupt('SIGTERM');
    const finish = status => {
      if (settled) return; settled = true;
      processImpl.removeListener('SIGINT', onInt); processImpl.removeListener('SIGTERM', onTerm);
      stop?.(); resolve(status);
    };
    processImpl.once('SIGINT', onInt); processImpl.once('SIGTERM', onTerm);
    const read = chunk => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) { try { child.kill('SIGTERM'); } catch {} finish(false); return; }
      text += chunk;
      const code = /one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)?.[1], url = /https:\/\/github\.com\/login\/device/.exec(text)?.[0];
      if (stop || !code || !url) return;
      const stopEnter = offer(screen, { codeHint: 'Enter this code on GitHub', code, note: 'Use the GitHub account you sign in to MyLittleSwarm with.', label: 'GitHub', url, onInterrupt: onInt });
      const stopSpinner = screen.waiting('Waiting for GitHub');
      stop = () => { stopSpinner(); stopEnter(); };
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', () => finish(false));
    // gh diagnostics are not MyLittleSwarm instructions. The caller reports a fixed
    // failure message; never wrap arbitrary stderr in trusted chat markers.
    child.on('close', status => finish(status === 0));
  });
}
// The service's MCP tools from a terminal, with the service's own credential, for a coding agent whose session started
// before MyLittleSwarm was registered and so has not loaded the tools yet.
export async function callServiceTool(values, positionals, out, err, { client = createRuntimeClient } = {}) {
  const unreachable = 'MyLittleSwarm’s local service didn’t answer. Check it with service-status, or start it with npm run setup. If the tool changes something, check before repeating it.';
  if (values.list ? positionals.length > 1 : positionals.length < 1 || positionals.length > 2) { err('Use tool --list [TOOL_NAME], or tool TOOL_NAME [\'JSON_ARGUMENTS\'].'); return 2; }
  let args = {};
  if (!values.list && positionals[1] !== undefined) {
    try { args = JSON.parse(positionals[1]); } catch { args = null; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) { err('The tool arguments must be one JSON object, such as \'{"project_id":"…"}\'.'); return 2; }
  }
  const runtime = client({ home: values['state-dir'] });
  try {
    if (values.list) {
      const tools = await runtime.listTools().catch(() => null);
      if (!tools) { err(unreachable); return 1; }
      if (positionals[0] === undefined) { out(JSON.stringify(tools.map(({ name, description }) => ({ name, description })), null, 2)); return 0; }
      const tool = tools.find(item => item.name === positionals[0]);
      if (!tool) { err(`There is no MyLittleSwarm tool named ${positionals[0]}. Run tool --list to see them.`); return 2; }
      out(JSON.stringify(tool, null, 2)); return 0;
    }
    const reply = await runtime.callTool(positionals[0], args).catch(() => null);
    if (!reply) { err(unreachable); return 1; }
    const text = (reply.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
    let shown = text;
    try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    (reply.isError ? err : out)(shown);
    return reply.isError ? 1 : 0;
  } finally { await runtime.close().catch(() => {}); }
}
function managementCall(command, values) {
  if (command === 'run-pause' || command === 'run-resume') {
    if (values.approve !== true || !/^[1-9]\d*$/.test(values.generation ?? '') || !Number.isSafeInteger(Number(values.generation)))
      throw new Error('Use the exact mission generation and explicit human approval.');
    return {name:'control_agent',args:commandSchema.parse({operationId:values['request-id'],missionId:values.mission,
      target:{projectId:values.project,agentId:values.agent},generation:Number(values.generation),
      kind:command==='run-pause'?'pause':'resume',payload:command==='run-pause'?{}:{pauseOperationId:values['pause-request']}})};
  }
  if(command==='run-recover') {
    const integer=(value,minimum)=>typeof value==='string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value)>=minimum;
    if(values.approve!==true)throw new Error('Use explicit human approval before recovery.');
    if(values.action!=='archive_failed_launch_report' && !integer(values.generation,1))throw new Error('Use the exact generation for this recovery.');
    const input={operationId:values['request-id'],missionId:values.mission,...(values.generation===undefined?{}:{generation:Number(values.generation)}),
      target:{projectId:values.project,agentId:values.agent},action:values.action,reason:values.reason,approved:true};
    if(values.action==='retry_report') {
      if(!integer(values.attempts,0))throw new Error('Supply the observed report attempt count.');
      Object.assign(input,{reportId:values.report,expectedAttempts:Number(values.attempts),expectedErrorCode:values['error-code']});
    } else if(values.action==='archive_failed_launch_report') {
      if(values.attempts!==undefined)throw new Error('Archiving uses the observed error code, not an attempt count.');
      Object.assign(input,{reportId:values.report,expectedErrorCode:values['error-code']});
    } else if([values.report,values.attempts,values['error-code']].some(value=>value!==undefined))throw new Error('Report fields belong only to retry_report.');
    return {name:'recover_agent_run',args:recoverySchema.parse(input)};
  }
  if (command === 'run-log' || command === 'run-diagnostics') {
    if (['mission','project','agent'].some(key => !values[key])) throw new Error('Supply the exact mission, project and agent from runtime mission status.');
    const args = {missionId:values.mission,target:{projectId:values.project,agentId:values.agent}};
    for (const key of ['after','limit']) if (values[key] !== undefined) {
      const value = Number(values[key]);
      if (!/^(0|[1-9]\d*)$/.test(values[key]) || !Number.isSafeInteger(value) || (key === 'limit' && (value < 1 || value > 100))) throw new Error('Use a nonnegative log cursor and a page limit between 1 and 100.');
      args[key] = value;
    }
    return {name:command === 'run-log' ? 'get_agent_run_log' : 'get_agent_run_diagnostics',args};
  }
  const tools = {'project-overview':'get_project_overview','project-configure':'set_project_repository','project-card':'update_project_card','project-publish':'publish_to_explore','project-create-private':'create_private_project','project-agents':'list_project_agents','agents-register':'register_my_agents','my-projects':'list_my_projects','my-proposals':'list_my_proposals','proposal-status':'get_my_proposal','project-start':'control_project'};
  if (!tools[command]) throw new Error('Owner command is unknown.');
  const args = command === 'project-start' ? { action: 'start' } : {};
  if (values.names !== undefined) args.names=values.names.split(',');
  for (const [cli,tool] of [['repo','repoUrl'],['start-date','startDeadline'],['title','title'],['goal','goal'],['project','project_id'],['cursor','cursor'],['scope','scope'],['request-id','client_request_id'],['approve','approved'],['start-without-minimum','start_without_minimum']]) if (values[cli] !== undefined) args[tool] = values[cli];
  if (values.revision !== undefined) { if (!/^(0|[1-9]\d*)$/.test(values.revision)) throw new Error('Owner revision must be a nonnegative integer from project-overview.'); args.expected_revision=Number(values.revision); }
  for (const [cli,key] of [['minimum','minContributors'],['card-version','expected_version']]) if (values[cli] !== undefined) { if (!/^[1-9]\d*$/.test(values[cli])) throw new Error('Owner settings require a positive integer.'); args[key]=Number(values[cli]); }
  if (values['definition-file'] !== undefined) {
    if (!isAbsolute(values['definition-file'])) throw new Error('Use an absolute JSON definition file from project-overview.');
    const text=readFileSync(values['definition-file'],'utf8');
    if (Buffer.byteLength(text)>16000) throw new Error('Owner Card definition is too large.');
    try { args.definition=JSON.parse(text); } catch { throw new Error('Owner Card definition must be valid JSON.'); }
  }
  return { name: tools[command], args };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
