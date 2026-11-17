import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
// TOML integers are 64-bit; those past 2^53 read as BigInt instead of being refused.
const parse = text => parseToml(text, { integersAsBigInt: 'asNeeded' });
import { spawnSync } from 'node:child_process';
import { reusableConfiguration, RETIRED_NAME } from './mcp-configuration.mjs';
import { resolveWindowsCommand } from './windows-command.mjs';
import { replaceFile, readPrivate, writePrivate, lstatExists } from './state.mjs';
import { BUNDLED_SKILL, bundledGuideFiles, installedSkill, readInstalledGuideFile, skillTextHash } from './skill-bundle.mjs';

// A settings file linked from elsewhere, such as a dotfiles folder, is updated where it lives, so the
// link keeps working. A link to a missing file is left for the person.
function linkedFile(path) {
  try { if (!lstatSync(path).isSymbolicLink()) return path; } catch (error) { if (error.code === 'ENOENT') return path; throw error; }
  let real;
  try { real = realpathSync(path); } catch (error) { if (error.code === 'ENOENT') throw new Error(`${path} links to a missing file, so setup left it unchanged`); throw error; }
  if (!statSync(real).isFile()) throw new Error(`${path} links to something other than a file, so setup left it unchanged`);
  return real;
}
// Replaces a client's file in one step, keeping its permissions, so a client never reads half of it.
// An unchanged file is not written: a running client may be saving the same file.
function replace(path, text) {
  path = linkedFile(path);
  let mode = 0o600;
  try { mode = statSync(path).mode & 0o777; if (readFileSync(path, 'utf8') === text) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode, flag: 'wx' });
  try { replaceFile(temp, path); } finally { try { unlinkSync(temp); } catch {} }
}
function readJson(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  // Some Windows editors save JSON with a byte order mark, which JSON.parse refuses.
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} is not a settings object`);
  return value;
}

function parses(text) { try { parse(text); return true; } catch { return false; } }
const replaced = name => entry => entry === name || RETIRED_NAME.test(entry);
// The settings without the minions entry and the retired per-engine ones, as plain objects to compare; an mcp_servers
// left empty counts as absent, as in a file that never had it.
function withoutEntry(settings, name) {
  settings = structuredClone(settings);
  const { mcp_servers: servers, ...rest } = settings;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return settings;
  const others = Object.fromEntries(Object.entries(servers).filter(([entry]) => !replaced(name)(entry)));
  return Object.keys(others).length ? { ...rest, mcp_servers: others } : rest;
}
// Only the table's own entry, the retired per-engine entries and their subtables are replaced, line by line so
// comments and layout are kept. The result must parse to the same settings with only those entries changed; anything
// else is left for the person.
export function withCodexEntry(text, table) {
  const [name] = Object.keys(parse(table).mcp_servers);
  let settings;
  try { settings = parse(text); } catch { throw new Error('it is not valid TOML'); }
  const lines = text.split(/\r?\n/), kept = [], newline = text.includes('\r\n') ? '\r\n' : '\n';
  let inside = false, pending = [];
  for (let i = 0; i < lines.length; i++) {
    // A bracket line inside a multi-line string or array is a value. Before a real table header, the
    // lines so far parse on their own.
    if (/^\s*\[/.test(lines[i]) && parses(lines.slice(0, i).join('\n'))) {
      const was = inside;
      inside = Object.keys(parse(lines[i]).mcp_servers ?? {}).some(replaced(name));
      // Comments and blank lines right above the next table belong to it, not to this entry.
      if (was && !inside) kept.push(...pending);
      pending = [];
    }
    if (!inside) kept.push(lines[i]);
    else if (/^\s*#/.test(lines[i]) || pending.length && !lines[i].trim()) pending.push(lines[i]);
    else pending = [];
  }
  const rest = kept.join(newline).trimEnd();
  const result = `${rest ? `${rest}${newline}${newline}` : ''}${table.replaceAll('\n', newline)}${newline}`;
  // A dotted key for this entry or an inline mcp_servers table cannot take the new table, so the result would not
  // parse or would differ elsewhere.
  let written;
  try { written = parse(result); } catch { written = null; }
  if (!written || !isDeepStrictEqual(withoutEntry(written, name), withoutEntry(settings, name))
    || !isDeepStrictEqual(structuredClone(written.mcp_servers?.[name]), structuredClone(parse(table).mcp_servers[name]))) throw new Error(`its settings name mcp_servers or ${name} in a form setup does not change`);
  return result;
}

// The router setup last wrote at each skill path, by hash. An older router's own hash is not known, so only this
// record shows whether the person edited it since; a router edited after setup recorded it is kept on update.
// Skills installed before this record existed have none and are updated as before.
const installedRouters = home => join(home, 'installed-skills.json');
function readRouters(home) {
  try { const value = lstatExists(installedRouters(home)) ? readPrivate(installedRouters(home), true) : {}; return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
function recordRouter(home, path, text) {
  try { writePrivate(installedRouters(home), { ...readRouters(home), [path]: skillTextHash(text) }); } catch {} // A missing record only loses this protection.
}

function installSkill(path, home) {
  const installed = installedSkill({ path }, BUNDLED_SKILL), { status } = installed;
  if (status === 'current') { recordRouter(home, path, bundledGuideFiles()['SKILL.md']); return null; }
  if (status === 'update_available') {
    const recorded = readRouters(home)[path];
    try { if (recorded && skillTextHash(readInstalledGuideFile(dirname(path), 'SKILL.md')) !== recorded) return `kept your own Minions skill at ${path}`; }
    catch { return `kept your own Minions skill at ${path}`; }
  }
  if (['not_installed', 'update_available', 'incomplete'].includes(status)) {
    const root = dirname(path), files = bundledGuideFiles();
    // Inspect every destination before writing any file. In particular, a missing
    // router does not permit overwriting an existing customized reference.
    for (const [file, content] of Object.entries(files)) {
      try {
        const existing = readInstalledGuideFile(root, file);
        const upgradingKnownFile = status === 'update_available' && (file === 'SKILL.md' || installed.references_sha256);
        if (!upgradingKnownFile && skillTextHash(existing) !== skillTextHash(content)) return `kept your own Minions skill at ${path}`;
      } catch (error) { if (error.code !== 'ENOENT') return `kept your own Minions skill at ${path}`; }
    }
    // References first: once the new router is visible, all its links exist.
    for (const [file, content] of Object.entries(files)) if (file !== 'SKILL.md') replace(join(root, file), content);
    replace(path, files['SKILL.md']);
    recordRouter(home, path, files['SKILL.md']);
    return null;
  }
  return `kept your own Minions skill at ${path}`;
}

function connectClaude({ home, userHome }) {
  const config = reusableConfiguration({ client: 'claude', home });
  const registry = join(userHome, '.claude.json');
  const servers = readJson(registry), current = servers.mcpServers ?? {};
  const kept = Object.fromEntries(Object.entries(current).filter(([name]) => !RETIRED_NAME.test(name)));
  if (!isDeepStrictEqual(current[config.name], config.entry) || Object.keys(kept).length !== Object.keys(current).length)
    replace(registry, `${JSON.stringify({ ...servers, mcpServers: { ...kept, [config.name]: config.entry } }, null, 2)}\n`);
  allowTools(userHome, config.name);
  return installSkill(join(userHome, '.claude', 'skills', 'minions', 'SKILL.md'), home);
}

// Minions asks the person in chat before important actions, so Claude Code need not ask again for each tool.
// The retired per-engine permissions go with their entries.
function allowTools(userHome, name) {
  const path = join(userHome, '.claude', 'settings.json'), settings = readJson(path), allow = settings.permissions?.allow ?? [];
  const permission = `mcp__${name}`, retired = entry => typeof entry === 'string' && RETIRED_NAME.test(entry.replace(/^mcp__/, ''));
  if (allow.includes(permission) && !allow.some(retired)) return;
  replace(path, `${JSON.stringify({ ...settings, permissions: { ...settings.permissions, allow: [...allow.filter(entry => !retired(entry) && entry !== permission), permission] } }, null, 2)}\n`);
}

function writeCodexEntry({ home, codexHome }) {
  const config = reusableConfiguration({ client: 'codex', home }), path = join(codexHome, 'config.toml');
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const written = withCodexEntry(text, config.toml);
  if (written === text) return { status: 'current', name: config.name };
  replace(path, written);
  return { status: 'registered', name: config.name };
}

function connectCodex({ home, userHome, codexHome }) {
  writeCodexEntry({ home, codexHome });
  return installSkill(join(userHome, '.agents', 'skills', 'minions', 'SKILL.md'), home);
}

const codexFolder = (userHome, env) => isAbsolute(env.CODEX_HOME ?? '') ? env.CODEX_HOME : join(userHome, '.codex');

// Writes the minions table into Codex's user config.toml when Codex is on this computer, replacing the retired
// per-engine tables (owner decision, 14 November 2026). Returns missing, current or registered.
export function registerWithCodex({ home, userHome = homedir(), env = process.env } = {}) {
  const codexHome = codexFolder(userHome, env);
  if (!existsSync(codexHome)) return { status: 'missing', name: 'minions' };
  return writeCodexEntry({ home, codexHome });
}

// Connects every coding client found on this computer to the shared service: its registration, its
// permission for Minions's tools and the bundled skill. A skill the person changed is kept.
export function connectClients({ home, userHome = homedir(), env = process.env } = {}) {
  const codexHome = codexFolder(userHome, env);
  const clients = [
    { name: 'Claude Code', found: existsSync(join(userHome, '.claude')) || existsSync(join(userHome, '.claude.json')), connect: connectClaude },
    { name: 'Codex', found: existsSync(codexHome), connect: connectCodex },
  ].filter(client => client.found);
  return clients.map(client => {
    try { return { client: client.name, connected: true, note: client.connect({ home, userHome, codexHome }) }; }
    catch (error) { return { client: client.name, connected: false, note: error.message }; }
  });
}

// Runs Claude Code's own claude command without a shell. On Windows an npm .cmd shim runs its JavaScript entry point
// with this Node, as for workers; a native claude.exe runs directly. null when there is no claude command.
function claudeCommand(args, { env = process.env, platform = process.platform } = {}) {
  let command = 'claude', argv = args;
  if (platform === 'win32') {
    try { ({ command, args: argv } = resolveWindowsCommand('claude', args, { env })); }
    catch (error) { if (/not found on PATH/.test(error.message)) return null; throw new Error(`Claude Code’s claude command could not be run without a shell: ${error.message}`); }
  }
  const result = spawnSync(command, argv, { env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error?.code === 'ENOENT') return null;
  if (result.error) throw new Error(`claude ${args.slice(0, 2).join(' ')} did not finish: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// Registers this installation's HTTP entry in Claude Code's user settings through the claude command, the way
// mcp-config tells a person to (owner decision, 13 November 2026). A matching user entry is left as it is;
// a stale address or authentication helper is replaced. The retired per-engine entries are
// removed, so the computer keeps one minions entry (owner decision, 14 November 2026). Returns missing, current or
// registered.
export function registerWithClaudeCode({ home, userHome = homedir(), run = claudeCommand } = {}) {
  const config = reusableConfiguration({ client: 'claude', home });
  const existing = run(['mcp', 'get', config.name]);
  if (existing === null) return { status: 'missing', name: config.name };
  const servers = readJson(join(userHome, '.claude.json')).mcpServers ?? {};
  for (const name of Object.keys(servers).filter(name => RETIRED_NAME.test(name)))
    run(['mcp', 'remove', '--scope', 'user', name]);
  allowTools(userHome, config.name);
  if (existing.status === 0 && isDeepStrictEqual(servers[config.name], config.entry)) return { status: 'current', name: config.name };
  if (existing.status === 0) run(['mcp', 'remove', '--scope', 'user', config.name]);
  const added = run(['mcp', 'add-json', '--scope', 'user', config.name, JSON.stringify(config.entry)]);
  if (added === null) return { status: 'missing', name: config.name };
  if (added.status !== 0) throw new Error(`claude mcp add-json failed: ${(added.stderr || added.stdout).trim().slice(0, 500) || `exit ${added.status}`}`);
  return { status: 'registered', name: config.name };
}
