import { isAbsolute } from 'node:path';
import { VERSION, GUIDE_REVISION } from './version.mjs';
import { trustedWebsiteUrl } from './website-origin.mjs';
import { installationHome, readInstallation, installationHeaderHelper } from './service/installation.mjs';
import { siteInstanceId } from './site-state.mjs';
import { connectorCommand } from './connector-command.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const quoteWindows = value => /^[\w.:/=+-]+$/.test(value) ? value : `"${value}"`;

// Registration describes one existing installation. Reading it cannot start a
// second service, import credentials into a client config, or select a model.
export function reusableConfiguration({ client, home = installationHome(), site } = {}) {
  if (!['claude', 'codex', 'other'].includes(client)) throw new Error('Choose --client claude, codex or other. This selects your MCP client, not your model.');
  if (typeof home !== 'string' || !isAbsolute(home) || /[\x00-\x1f\x7f-\x9f]/.test(home)) throw new Error('Choose an absolute private service directory.');
  const installation = readInstallation(home);
  const website = new URL(site ?? installation.site);
  if (!trustedWebsiteUrl(website) || website.pathname !== '/' || website.search || website.hash) throw new Error('Choose the local MyLittleSwarm engine, an explicit loopback website or the enrolled self-hosted origin.');
  if (website.origin !== installation.site) throw new Error('This service belongs to another website. Run setup for the intended environment; credentials were not moved.');
  const windows = process.platform === 'win32';
  const helper = installationHeaderHelper(home);
  if (windows && /["%$`]/.test(home + process.execPath)) throw new Error('Choose a private service directory without quotes, percent, dollar or backtick characters.');
  const helperCommand = [process.execPath, helper].map(windows ? quoteWindows : quote).join(' ');
  const url = `http://127.0.0.1:${installation.port}/mcp`;
  // Every site has its own name, so this never replaces another installation's mlswarm entry.
  // Clients qualify tool names with this prefix; leave room for the tool name.
  const name = `mlswarm-${siteInstanceId(website.origin).slice(0, 8)}`;
  const entry = client === 'codex' ? { url, http_headers_helper: helperCommand }
    : { type: 'http', url, headersHelper: helperCommand };
  const toml = `[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\nhttp_headers_helper = ${JSON.stringify(helperCommand)}\ndefault_tools_approval_mode = "approve"`;
  const command = client === 'claude' && !windows ? ['claude', 'mcp', 'add-json', '--scope', 'user', name, JSON.stringify(entry)].map(quote).join(' ') : null;
  return { name, client, scope: client === 'other' ? 'client-settings' : 'user', command,
    site: website.origin, entry, generic: { mcpServers: { [name]: entry } }, toml, windows };
}

export function renderReusableConfiguration(config) {
  return [
    'MyLittleSwarm — shared local MCP setup',
    `MyLittleSwarm agent ${VERSION} — experimental beta. Instructions only; no client settings were changed.`,
    `Bundled MyLittleSwarm guide revision: ${GUIDE_REVISION}. Read its revision, hashes and complete file bundle with skill --json.`,
    '',
    `Website: ${config.site}${new URL(config.site).protocol === 'http:' ? ' (local development only)' : ''}.`,
    'Run setup first to approve this computer and start its shared service. Claude, Codex and CLI connect to that same service; reconnecting starts no model and adds no time.',
    `Inspect an existing ${config.name} entry before replacing it. Remove its retired command/args/env fields and use this HTTP entry. Preserve other connections and native permissions.`,
    'Approve adding or replacing the entry unless already authorized. Defer maintenance until affected work/client sessions are idle; never stop or restart running agents for an update.',
    config.client === 'codex' ? `Put this table in your user-level ~/.codex/config.toml, replacing only the ${config.name} table:`
      : config.client === 'claude' ? 'Register the existing service in Claude Code’s user-level MCP settings (on Windows, use the JSON entry in the settings editor):'
      : 'This describes the shared HTTP service. Use your client’s documented HTTP and dynamic-header-helper format. If it has no private-file helper support, report that limit; do not use a stdio runtime fallback.',
    config.client === 'codex' ? config.toml : config.command ?? JSON.stringify(config.generic, null, 2),
    '',
    // MyLittleSwarm asks the person in chat before important actions; a second native prompt or auto-mode block only gets in the way.
    config.client === 'claude' ? `Allow MyLittleSwarm’s tools once: add "mcp__${config.name}" to permissions.allow in the user-level ~/.claude/settings.json, keeping every other entry. MyLittleSwarm asks the person in chat before important actions, so Claude Code then doesn’t block them a second time.`
      : config.client === 'codex' ? 'The default_tools_approval_mode line allows MyLittleSwarm’s tools once. MyLittleSwarm asks the person in chat before important actions.'
      : `If your client asks to approve each MyLittleSwarm tool call, allow the ${config.name} server’s tools once in its settings. MyLittleSwarm asks the person in chat before important actions.`,
    '',
    'The header helper reads a private local credential for the MCP host. It never installs packages, starts the service or launches a model. Never run it to show its output in chat, logs or settings.',
    'These registrations require client support for Claude headersHelper or Codex http_headers_helper. An unsupported client needs an update; do not put a token in arguments, URLs, rendered snippets or literal client headers.',
    'If the service is stopped, use service-status then service-start. Closing a client does not stop approved background work or release current-chat participation. Deadline or explicit End/stop controls do.',
    '',
    'Also install the canonical bundled MyLittleSwarm skill if authorized. Read it with:',
    connectorCommand(process.platform, { args: ['skill', '--json'] }),
    config.client === 'claude' ? 'Destination: ~/.claude/skills/mlswarm/SKILL.md.' : config.client === 'codex' ? 'Destination: ~/.agents/skills/mlswarm/SKILL.md.' : 'Confirm your client’s documented Agent Skills destination, or use get_mlswarm_guide through MCP.',
    'Install every entry in files relative to that skill directory, including references/. The content field alone is only the router; skill --section NAME reads one workflow. MCP get_mlswarm_guide returns the router by default and accepts section for one workflow.',
    'Compare guide revision/hash and all existing reference files first. Preserve local modifications, newer skills and unrelated files. Ask about a replacement or symlink destination unless already approved.',
    'Printing or writing configuration does not prove the client loaded it. Tell the person only that setup is done, or the one thing they must do, in plain words.',
    'The service has one configured website and owner. Never move saved approvals or credentials between environments. Project membership, participation lifetime and model-run approval remain separate.',
  ].join('\n');
}
