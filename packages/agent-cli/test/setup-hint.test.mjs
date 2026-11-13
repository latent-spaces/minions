import test from 'node:test';
import assert from 'node:assert/strict';
import { separateInstallationHint } from '../src/cli.mjs';
import { CONNECTOR_ENTRY, connectorCommand } from '../src/connector-command.mjs';

test('the separate-installation hint runs this checkout\'s connector with the current Node', () => {
  const hint = separateInstallationHint('/Users/Ana Lee/mlswarm test', 'darwin');
  assert.doesNotMatch(hint, /\||npx|@mlswarm/);
  assert.ok(hint.endsWith(connectorCommand('darwin', { node: process.execPath, cli: CONNECTOR_ENTRY, args: ['mcp-config', '--client', 'claude', '--state-dir', '/Users/Ana Lee/mlswarm test'] })));
  assert.match(hint, / 'mcp-config' '--client' 'claude' '--state-dir' '\/Users\/Ana Lee\/mlswarm test'$/);
  assert.match(separateInstallationHint('C:\\Users\\%USERNAME%\\k', 'win32'), /^.*: & '.+' '.+' 'mcp-config' '--client' 'claude' '--state-dir' 'C:\\Users\\%USERNAME%\\k'$/);
});

test('connector commands keep paths with spaces, quotes, $ and % as single arguments on both shells', () => {
  const posix = connectorCommand('darwin', { node: '/opt/node 24/bin/node', cli: "/Users/ana/it's/cli.mjs", env: { MLSWARM_SERVICE_HOME: '/s h' }, args: ['skill', '--json'] });
  assert.equal(posix, "MLSWARM_SERVICE_HOME='/s h' '/opt/node 24/bin/node' '/Users/ana/it'\\''s/cli.mjs' 'skill' '--json'");
  const windows = connectorCommand('win32', { node: 'C:\\Program Files\\nodejs\\node.exe', cli: "C:\\Users\\Ana O'Neil\\$x %y%\\cli.mjs", args: ['skill'] });
  assert.equal(windows, "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\Ana O''Neil\\$x %y%\\cli.mjs' 'skill'");
  assert.equal(connectorCommand('win32', { node: 'n', cli: 'c', env: { A: 'x' } }), "$env:A='x'; & 'n' 'c'");
});

test('PowerShell commands double curly single quotes, which PowerShell also reads as quote marks', () => {
  assert.equal(connectorCommand('win32', { node: 'n', cli: 'C:\\Users\\Ana O\u2019Neil\\\u2018a\u201a\u201b\\cli.mjs' }),
    "& 'n' 'C:\\Users\\Ana O\u2019\u2019Neil\\\u2018\u2018a\u201a\u201a\u201b\u201b\\cli.mjs'");
});
