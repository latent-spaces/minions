#!/usr/bin/env node
// `minions`: wake, check and tuck in this computer's Minions engine and shared service. `npm run setup` links it
// onto PATH. It reuses the setup command, the engine CLI and the connector CLI through engine-control.mjs and adds no
// second implementation of any of them. At a terminal it is playful; piped or called by an agent it prints plain
// lines (owner, 16 November 2026). Nothing here runs a model.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { initializationState, occupiedMessage, requireNode24, settingsText } from './engine-plan.mjs';
import { at, connector, engineMain, engineState, locate, openPage, portHolder, repository, startEngine, stopEngine } from './engine-control.mjs';

const tty = process.stdout.isTTY === true && !process.env.MINIONS_PLAIN;
const colored = tty && !process.env.NO_COLOR;
const paint = code => text => colored ? `\x1b[${code}m${text}\x1b[0m` : text;
const yellow = paint('33'), green = paint('32'), dim = paint('2'), bold = paint('1'), cyan = paint('36'), magenta = paint('35');
const pick = list => list[Math.floor(Math.random() * list.length)];
const say = (fun, plain = fun) => console.info(tty ? fun : plain);

// Three little original heads, because a swarm needs company.
const ART = {
  awake: [
    '    \\|/      \\|/      \\|/',
    '   (^_^)    (o.o)    (^o^)',
  ],
  asleep: [
    '                          z Z',
    '   (-_-)    (-.-)    (-_-)',
  ],
  confused: [
    '     ?        ?        ?',
    '   (o_O)    (O_o)    (o_o)',
  ],
  busy: [
    '    \\|/  ~   \\|/  ~   \\|/',
    '   (>_<)    (>.<)    (>_<)',
  ],
};
const art = (mood, color = yellow) => { if (tty) console.info(`\n${ART[mood].map(line => color(line)).join('\n')}\n`); };

const WAKE = ['Minions are awake and ready to work!', 'Rise and shine, the swarm is up!', 'All minions present and accounted for!', 'The swarm stretches, yawns and gets to work.'];
const SLEEP = ['Minions are tucked in. Sleep tight!', 'Lights out, little swarm.', 'The swarm curls up for a nap.', 'Shhh... minions are dreaming of merged pull requests.'];

/** A small spinner for waits at a terminal; plain output gets one line instead. */
function spinner(text) {
  if (!tty) { console.info(`${text}...`); return () => {}; }
  const frames = ['(o.o)  ', ' (o.o) ', '  (o.o)', ' (o.o) '];
  let index = 0;
  const draw = () => process.stdout.write(`\r${yellow(frames[index++ % frames.length])} ${text}...`);
  draw();
  const timer = setInterval(draw, 160);
  return () => { clearInterval(timer); process.stdout.write('\r\x1b[2K'); };
}

const HELP = `minions: wake, check and tuck in your local Minions

Usage: minions <command> [options]

  start [--open]            Wake the engine and the shared service. A first run (nothing built
                            or initialized yet) runs setup instead. --open opens the local app.
  stop [--now] [--wait-minutes N]
                            Let the turns in progress finish (up to N minutes, default 10), then
                            stop the shared service and the engine. Agents continue in the same
                            missions on the next start. --now ends turns in progress at once.
  status [--json]           Is the engine running, and is the shared service? Where are the files?
  open                      Open the local app in your browser.
  logs [--service] [--lines N] [--follow]
                            Show the end of the engine log (or the shared service log).
  setup [setup options]     The full setup: install, build, initialize, start, sign in and
                            connect Claude Code and Codex. Same as npm run setup.
  update [--now] [--wait-minutes N]
                            Let turns finish, stop, pull main (fast-forward only), rebuild and
                            start again with setup.
  help                      This page.

MINIONS_ENGINE_HOME and MINIONS_ENGINE_PORT choose another engine, as with npm run setup.
MINIONS_PLAIN=1 or NO_COLOR turns off the critters or the colors.`;

/** The full setup, with the person's terminal attached; resolves with its exit code. */
function setup(args = []) {
  return new Promise(accept => {
    const child = spawn(process.execPath, [at('tools/setup/engine-setup.mjs'), ...args], { cwd: repository, stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', error => { console.error(error.message); accept(1); });
    child.once('exit', code => accept(code ?? 1));
  });
}

/** The shared service's status from the connector, or { running: false, error } when it could not be read. */
async function serviceStatus(installation) {
  const result = await connector(['service-status'], installation.connectorEnv);
  try { if (result.code === 0) return JSON.parse(result.stdout); } catch {}
  return { running: false, error: (result.stderr || result.stdout).trim() || 'The shared service status could not be read.' };
}

function initialized({ files }) {
  return initializationState({ database: existsSync(files.sqlitePath), owner: existsSync(files.ownerFile) });
}

/** A mistake in how the command was called: exit 2, as with an unknown command or option. */
const usage = message => Object.assign(new Error(message), { code: 'ERR_PARSE_ARGS_USAGE' });

async function start(args) {
  const { values } = parseArgs({ args, options: { open: { type: 'boolean' } } });
  const installation = locate();
  const { files, port, site, engineEnv, connectorEnv } = installation;
  if (initialized(installation) !== 'existing' || !existsSync(engineMain)) {
    say(`${yellow('(o.o)?')} No minion den here yet. Building one with the full setup first!`, 'Nothing is built or initialized yet; running the full setup.');
    return setup();
  }
  const state = await engineState(installation);
  if (state === 'other') throw new Error(occupiedMessage(port, portHolder(port)).replace('run npm run setup again', 'run minions start again'));
  if (state === 'free') {
    const done = spinner('Waking the engine');
    let url;
    try {
      writeFileSync(files.settingsFile, settingsText(port), { mode: 0o600 });
      url = await startEngine(engineEnv, files);
    } finally { done(); }
    say(`${green('*')} Engine awake at ${cyan(url)}`, `The engine is running at ${url}.`);
  } else say(`${green('*')} Engine was already up at ${cyan(site)}`, `The engine was already running at ${site}.`);

  const done = spinner('Waking the shared service');
  const service = await connector(['service-start', '--site', site], connectorEnv);
  done();
  let ready = service.code === 0;
  if (ready) say(`${green('*')} Shared service ready for your coding agents`, 'The shared service is running.');
  else {
    console.error(`The shared service did not start: ${(service.stderr || service.stdout).trim() || `exit ${service.code}`}`);
    console.error('The engine keeps running. If this computer was never fully set up, run minions setup.');
  }
  if (values.open) openPage(`${site}/`);
  if (ready) {
    art('awake');
    say(bold(pick(WAKE)), 'Minions are running.');
  }
  say(dim(`Local app: ${site}/  ·  minions open  ·  minions status  ·  minions stop`), `Local app: ${site}/`);
  return ready ? 0 : 1;
}

/**
 * Stops the shared service, letting the turns in progress finish unless now, then the engine. Resolves false and
 * leaves the engine running when turns are still finishing, so they can complete.
 */
async function rest(installation, { now, minutes, requireServiceStopped = false }) {
  const service = await serviceStatus(installation);
  if (service.running) {
    const done = spinner(now ? 'Stopping the shared service' : `Letting minions finish their turns (up to ${minutes} min)`);
    const result = await connector(now ? ['service-stop'] : ['service-stop', '--after-turns', '--wait-minutes', String(minutes)], installation.connectorEnv);
    done();
    if (result.code !== 0) {
      console.error((result.stderr || result.stdout).trim().replace(/service-stop --after-turns/g, 'minions stop').replace(/service-stop/g, 'minions stop --now'));
      console.error('The engine was left running so those turns can finish.');
      return false;
    }
    say(`${green('*')} Shared service stopped`, 'The shared service stopped.');
  } else if (service.error) {
    // An unreadable status may hide a service still running turns, so only --now stops the engine under it (review of PR 69).
    say(`${yellow('!')} ${service.error}`, service.error);
    if (!now || requireServiceStopped) {
      console.error(requireServiceStopped
        ? 'The shared service state is unknown, so the checkout and engine were left alone. Resolve the service status before updating.'
        : 'The shared service state is unknown, so the engine was left running. Run minions stop --now to stop it anyway.');
      return false;
    }
  }
  const state = await engineState(installation);
  if (state === 'running') {
    const done = spinner('Tucking in the engine');
    try { await stopEngine(installation, { quiet: true }); } finally { done(); }
    say(`${green('*')} Engine stopped`, 'The engine stopped.');
  } else if (state === 'other') say(`${yellow('!')} Port ${installation.port} belongs to another program; it was left alone.`, `Port ${installation.port} is used by another program; it was left alone.`);
  return true;
}

function waitOptions(args) {
  const { values } = parseArgs({ args, options: { now: { type: 'boolean' }, 'wait-minutes': { type: 'string' } } });
  const minutes = values['wait-minutes'] ?? '10';
  if (!/^[1-9]\d{0,3}$/.test(minutes)) throw usage('--wait-minutes takes a whole number from 1 to 9999.');
  if (values.now && values['wait-minutes']) throw usage('--now does not wait, so it takes no --wait-minutes.');
  return { now: values.now === true, minutes: Number(minutes) };
}

async function stop(args) {
  const options = waitOptions(args);
  const installation = locate();
  if (await engineState(installation) !== 'running' && !(await serviceStatus(installation)).running) {
    art('asleep', magenta);
    say(bold('Minions are already asleep. Zzz...'), 'Minions are not running.');
    return 0;
  }
  if (!await rest(installation, options)) { art('busy'); return 1; }
  art('asleep', magenta);
  say(bold(pick(SLEEP)), 'Minions stopped.');
  return 0;
}

async function status(args) {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const installation = locate();
  const { home, files, site, port } = installation;
  const engine = await engineState(installation);
  const service = await serviceStatus(installation);
  const built = existsSync(engineMain), setUp = initialized(installation);
  if (values.json) {
    console.info(JSON.stringify({ engine, site, home, built, initialized: setUp, service, engineLog: files.engineLog }, null, 2));
    return 0;
  }
  const mood = engine === 'other' ? 'confused' : engine === 'running' && service.draining ? 'busy' : engine === 'running' ? 'awake' : 'asleep';
  art(mood, mood === 'asleep' ? magenta : yellow);
  const mark = good => good ? green('●') : dim('○');
  const engineText = engine === 'running' ? `running at ${cyan(site)}` : engine === 'other' ? `port ${port} is used by ${portHolder(port) ?? 'another program'}` : 'asleep';
  const serviceText = service.running ? (service.draining ? `finishing ${service.turnsInProgress ?? 'its'} turn(s), then stopping` : 'running') : service.error ? `unknown (${service.error})` : service.installed === false ? 'not set up yet' : 'asleep';
  say(`${mark(engine === 'running')} Engine          ${engineText}`, `Engine: ${engine === 'running' ? `running at ${site}` : engine === 'other' ? `port ${port} is used by another program` : 'stopped'}`);
  say(`${mark(service.running)} Shared service  ${serviceText}`, `Shared service: ${service.running ? (service.draining ? 'finishing turns, then stopping' : 'running') : service.error ? serviceText : 'stopped'}`);
  say(dim(`  Files           ${home}`), `Files: ${home}`);
  if (!built || setUp !== 'existing') say(`${yellow('!')} Not set up yet: run ${bold('minions setup')}`, 'Not set up yet: run minions setup.');
  else if (engine !== 'running') say(dim(`  Wake them with ${bold('minions start')}`), 'Start with: minions start');
  return 0;
}

async function open() {
  const installation = locate();
  if (await engineState(installation) !== 'running') {
    art('asleep', magenta);
    say(`Minions are asleep. Wake them with ${bold('minions start --open')}`, 'The engine is not running. Start it with: minions start --open');
    return 1;
  }
  const page = `${installation.site}/`;
  if (openPage(page)) say(`${green('*')} Opening ${cyan(page)}`, `Opening ${page}`);
  else console.info(`Open ${page} in your browser on this computer.`);
  return 0;
}

/** The last lines of a log, then, with follow, what is appended until Ctrl+C. Polling works alike on every platform. */
async function logs(args) {
  const { values } = parseArgs({ args, options: { service: { type: 'boolean' }, lines: { type: 'string' }, follow: { type: 'boolean', short: 'f' } } });
  const count = Number(values.lines ?? 40);
  if (!Number.isInteger(count) || count < 1 || count > 10_000) throw usage('--lines takes a whole number from 1 to 10000.');
  const { files } = locate();
  const file = values.service ? join(files.serviceHome, 'service.log') : files.engineLog;
  if (!existsSync(file)) throw new Error(`There is no log at ${file} yet.`);
  const read = (from, to) => {
    const fd = openSync(file, 'r');
    try { const buffer = Buffer.alloc(to - from); readSync(fd, buffer, 0, buffer.length, from); return buffer.toString('utf8'); } finally { closeSync(fd); }
  };
  let size = statSync(file).size;
  // The last 512 KiB is plenty for any --lines a person reads at a terminal.
  const tail = read(Math.max(0, size - 512 * 1024), size).split(/\r?\n/);
  if (tail.at(-1) === '') tail.pop();
  say(dim(`── ${file} ──`), `${file}:`);
  console.info(tail.slice(-count).join('\n'));
  if (!values.follow) return 0;
  say(dim('── following; Ctrl+C to stop ──'), '');
  for (;;) {
    await new Promise(accept => setTimeout(accept, 500));
    const now = statSync(file).size;
    if (now < size) size = 0; // The log was replaced; start from its beginning.
    if (now > size) { process.stdout.write(read(size, now)); size = now; }
  }
}

async function update(args) {
  const options = waitOptions(args);
  const pending = at('apps/server/dist/.minions-update-pending');
  const incomplete = existsSync(pending);
  const git = gitArgs => spawnSync('git', gitArgs, { cwd: repository, encoding: 'utf8', shell: false, windowsHide: true });
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim();
  if (!branch) throw new Error(`Could not read the Git branch of ${repository}. Update needs Git and a cloned checkout.`);
  if (branch !== 'main') throw new Error(`Update follows main, and ${repository} is on ${branch}. Nothing was changed.`);
  if (git(['status', '--porcelain', '--untracked-files=no']).stdout?.trim()) throw new Error(`${repository} has uncommitted changes. Commit or set them aside, then run minions update again. Nothing was changed.`);
  const before = git(['rev-parse', 'HEAD']).stdout.trim();
  // Fetch only: active turns and newly spawned guards must keep the old checkout until the service drains.
  say(`${yellow('(o.o)')} Checking the newest minions on main...`, 'Checking main for updates.');
  const fetched = spawnSync('git', ['fetch', 'origin', 'main'], { cwd: repository, stdio: 'inherit', shell: false, windowsHide: true });
  if (fetched.status !== 0) throw new Error('git fetch did not complete; nothing was changed or stopped.');
  const target = git(['rev-parse', 'FETCH_HEAD']).stdout?.trim();
  if (!target) throw new Error('Could not read the fetched main revision. Nothing was changed or stopped.');
  const current = git(['merge-base', '--is-ancestor', target, before]).status === 0;
  if (!current && git(['merge-base', '--is-ancestor', before, target]).status !== 0)
    throw new Error('main cannot fast-forward to origin/main. Nothing was changed or stopped.');
  // A build older than the checked-out commit means someone pulled by hand; rebuild then too (review of PR 69).
  const committed = Number(git(['log', '-1', '--format=%ct']).stdout.trim()) * 1000;
  if (current && !incomplete && existsSync(engineMain) && statSync(engineMain).mtimeMs >= committed) {
    art('awake');
    say(bold('Already up to date. The minions are as fresh as they get!'), 'Already up to date; nothing was rebuilt.');
    return 0;
  }
  const installation = locate();
  if (!await rest(installation, { ...options, requireServiceStopped: true })) {
    console.error('The checkout was left unchanged. Run minions update again once those turns have finished, or minions update --now.');
    return 1;
  }
  // A partial setup may emit the backend before a later build fails. Its mtime alone cannot complete this update.
  // Keep the ignored marker through pull/build failures and interruptions; clear it only after setup succeeds.
  mkdirSync(at('apps/server/dist'), { recursive: true });
  writeFileSync(pending, '');
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim() !== 'main'
    || git(['rev-parse', 'HEAD']).stdout?.trim() !== before
    || git(['status', '--porcelain', '--untracked-files=no']).stdout?.trim())
    throw new Error('The checkout changed while turns were finishing. Minions is stopped; nothing was pulled or rebuilt. Resolve the checkout and run minions update again.');
  say(`${yellow('(o.o)')} Fetching the newest minions from main...`, 'Pulling main (fast-forward only).');
  const pulled = spawnSync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: repository, stdio: 'inherit', shell: false, windowsHide: true });
  if (pulled.status !== 0) throw new Error('git pull --ff-only did not complete. Minions is stopped; nothing was rebuilt. Run minions start to restart the existing build.');
  const after = git(['rev-parse', 'HEAD']).stdout.trim();
  if (before === after) say(incomplete ? `${yellow('*')} Finishing the incomplete update` : `${green('*')} The build is older than ${after.slice(0, 7)}`,
    incomplete ? 'Finishing the incomplete update.' : `The build is older than ${after.slice(0, 7)}.`);
  else say(`${green('*')} Pulled ${before.slice(0, 7)} → ${after.slice(0, 7)}`, `Pulled ${before.slice(0, 7)} to ${after.slice(0, 7)}.`);
  say(`${yellow('(^o^)')} Rebuilding and waking them with setup!`, 'Rebuilding and starting with setup.');
  const result = await setup();
  if (result !== 0) console.error('Update setup did not complete. Resolve the error above and run minions setup to finish rebuilding and starting.');
  else rmSync(pending, { force: true });
  return result;
}

const COMMANDS = { start, stop, status, open, logs, update, setup: args => setup(args) };

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) { console.info(HELP); return 0; }
  if (!Object.hasOwn(COMMANDS, command)) {
    say(`${yellow('(o_O)?')} The minions don't know "${command}". Try ${bold('minions help')}.`, `Unknown command: ${command}. Run minions help.`);
    return 2;
  }
  requireNode24(process.version);
  try { return await COMMANDS[command](args); }
  catch (error) {
    if (error.code?.startsWith?.('ERR_PARSE_ARGS')) { console.error(`${error.message.replace(/\.$/, '')}. Run minions help.`); return 2; }
    console.error(error.message);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
