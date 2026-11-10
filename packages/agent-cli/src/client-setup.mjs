import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
// TOML integers are 64-bit; those past 2^53 read as BigInt instead of being refused.
const parse = text => parseToml(text, { integersAsBigInt: 'asNeeded' });
import { reusableConfiguration } from './mcp-configuration.mjs';
import { replaceFile } from './state.mjs';
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
// The settings without this installation's entry, as plain objects to compare; an mcp_servers left empty counts as
// absent, as in a file that never had it.
function withoutEntry(settings, name) {
  settings = structuredClone(settings);
  const { mcp_servers: servers, ...rest } = settings;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return settings;
  const { [name]: _entry, ...others } = servers;
  return Object.keys(others).length ? { ...rest, mcp_servers: others } : rest;
}
// Only the table's own entry and its subtables are replaced, line by line so comments and layout are kept. The result
// must parse to the same settings with only the new entry changed; anything else is left for the person.
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
      inside = Object.hasOwn(parse(lines[i]).mcp_servers ?? {}, name);
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

function installSkill(path) {
  const installed = installedSkill({ path }, BUNDLED_SKILL), { status } = installed;
  if (status === 'current') return null;
  if (['not_installed', 'update_available', 'incomplete'].includes(status)) {
    const root = dirname(path), files = bundledGuideFiles();
    // Inspect every destination before writing any file. In particular, a missing
    // router does not permit overwriting an existing customized reference.
    for (const [file, content] of Object.entries(files)) {
      try {
        const existing = readInstalledGuideFile(root, file);
        const upgradingKnownFile = status === 'update_available' && (file === 'SKILL.md' || installed.references_sha256);
        if (!upgradingKnownFile && skillTextHash(existing) !== skillTextHash(content)) return `kept your own MyLittleSwarm skill at ${path}`;
      } catch (error) { if (error.code !== 'ENOENT') return `kept your own MyLittleSwarm skill at ${path}`; }
    }
    // References first: once the new router is visible, all its links exist.
    for (const [file, content] of Object.entries(files)) if (file !== 'SKILL.md') replace(join(root, file), content);
    replace(path, files['SKILL.md']);
    return null;
  }
  return `kept your own MyLittleSwarm skill at ${path}`;
}

function connectClaude({ home, userHome }) {
  const config = reusableConfiguration({ client: 'claude', home });
  const registry = join(userHome, '.claude.json'), settingsPath = join(userHome, '.claude', 'settings.json');
  const servers = readJson(registry);
  // The entry has this site's own name, so another installation's mlswarm entry stays as it is.
  if (!isDeepStrictEqual(servers.mcpServers?.[config.name], config.entry)) replace(registry, `${JSON.stringify({ ...servers, mcpServers: { ...servers.mcpServers, [config.name]: config.entry } }, null, 2)}\n`);
  // MyLittleSwarm asks the person in chat before important actions, so Claude Code need not ask again for each tool.
  const settings = readJson(settingsPath), allow = settings.permissions?.allow ?? [], permission = `mcp__${config.name}`;
  if (!allow.includes(permission)) replace(settingsPath, `${JSON.stringify({ ...settings, permissions: { ...settings.permissions, allow: [...allow, permission] } }, null, 2)}\n`);
  return installSkill(join(userHome, '.claude', 'skills', 'mlswarm', 'SKILL.md'));
}

function connectCodex({ home, userHome, codexHome }) {
  const config = reusableConfiguration({ client: 'codex', home }), path = join(codexHome, 'config.toml');
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  replace(path, withCodexEntry(text, config.toml));
  return installSkill(join(userHome, '.agents', 'skills', 'mlswarm', 'SKILL.md'));
}

// Connects every coding client found on this computer to the shared service: its registration, its
// permission for MyLittleSwarm's tools and the bundled skill. A skill the person changed is kept.
export function connectClients({ home, userHome = homedir(), env = process.env } = {}) {
  const codexHome = isAbsolute(env.CODEX_HOME ?? '') ? env.CODEX_HOME : join(userHome, '.codex');
  const clients = [
    { name: 'Claude Code', found: existsSync(join(userHome, '.claude')) || existsSync(join(userHome, '.claude.json')), connect: connectClaude },
    { name: 'Codex', found: existsSync(codexHome), connect: connectCodex },
  ].filter(client => client.found);
  return clients.map(client => {
    try { return { client: client.name, connected: true, note: client.connect({ home, userHome, codexHome }) }; }
    catch (error) { return { client: client.name, connected: false, note: error.message }; }
  });
}
