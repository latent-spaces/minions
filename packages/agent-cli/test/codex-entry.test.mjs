import test from 'node:test';
import assert from 'node:assert/strict';
import { withCodexEntry } from '../src/client-setup.mjs';

test('a mlswarm table written with spaces around its dots is replaced, not duplicated', () => {
  assert.equal(withCodexEntry('model = "o3"\n\n[ mcp_servers . mlswarm ]\ncommand = "old"\n\n[ mcp_servers . mlswarm . env ]\nA = "1"\n', '[mcp_servers.mlswarm]\nurl = "u"'), 'model = "o3"\n\n[mcp_servers.mlswarm]\nurl = "u"\n');
  assert.equal(withCodexEntry('[mcp_servers . \'mlswarm\']\nurl = "x"\n', '[mcp_servers.mlswarm]\nurl = "u"'), '[mcp_servers.mlswarm]\nurl = "u"\n');
});

test('a quoted mcp_servers name is the same table, and a mlswarm_backup server is left alone', () => {
  assert.equal(withCodexEntry('["mcp_servers" . "mlswarm"]\ncommand = "old"\n', '[mcp_servers.mlswarm]\nurl = "u"'), '[mcp_servers.mlswarm]\nurl = "u"\n');
  assert.equal(withCodexEntry("['mcp_servers'.mlswarm]\nurl = \"x\"\n", '[mcp_servers.mlswarm]\nurl = "u"'), '[mcp_servers.mlswarm]\nurl = "u"\n');
  assert.equal(withCodexEntry('[mcp_servers.mlswarm_backup]\nurl = "b"\n', '[mcp_servers.mlswarm]\nurl = "u"'), '[mcp_servers.mlswarm_backup]\nurl = "b"\n\n[mcp_servers.mlswarm]\nurl = "u"\n');
});

test('a table-shaped line inside a multi-line string is text, so the file is never cut', () => {
  const example = 'developer_instructions = """\nWrite settings like:\n[mcp_servers.mlswarm]\n"""\n\n[other]\nkeep = true\n';
  // The example stays text, and the entry is added after it.
  assert.equal(withCodexEntry(example, '[mcp_servers.mlswarm]\nurl = "u"'), example.trimEnd() + '\n\n[mcp_servers.mlswarm]\nurl = "u"\n');
  const unrelated = "notes = '''\n[not a table]\n'''\n\n[mcp_servers.mlswarm]\ncommand = \"old\"\n";
  assert.equal(withCodexEntry(unrelated, '[mcp_servers.mlswarm]\nurl = "u"'), "notes = '''\n[not a table]\n'''\n\n[mcp_servers.mlswarm]\nurl = \"u\"\n");
  assert.throws(() => withCodexEntry('a = """\nnever closed\n', '[mcp_servers.mlswarm]'), /not valid TOML/);
});

test('a dotted mlswarm key under mcp_servers is refused, not duplicated', () => {
  assert.throws(() => withCodexEntry('[mcp_servers]\nmlswarm.command = "old"\n', '[mcp_servers.mlswarm]\nurl = "u"'), /does not change/);
});

test('quotes in comments, escaped quotes and quote runs do not hide tables', () => {
  const table = '[mcp_servers.mlswarm]\nurl = "u"';
  // Triple quotes in comments are not strings, so [other] is still a table and is kept.
  assert.equal(withCodexEntry('[mcp_servers.mlswarm]\ncommand = "old"\n# """ marker\n[other]\nkeep = true\n# """ end\n', table), '# """ marker\n[other]\nkeep = true\n# """ end\n\n' + table + '\n');
  // An escaped quote run does not close a basic multi-line string; a closing run may carry extra quotes.
  const strings = 'a = """\nsay \\"""\n[not a table]\n""""\nb = \'#"""\'\n\n[mcp_servers.mlswarm]\ncommand = "old"\n';
  assert.equal(withCodexEntry(strings, table), strings.slice(0, strings.indexOf('\n\n[mcp_servers')) + '\n\n' + table + '\n');
});

test('a line of a multi-line array that starts with a bracket is a value, not a table', () => {
  const table = '[mcp_servers.mlswarm]\nurl = "u"';
  assert.equal(withCodexEntry('[mcp_servers.mlswarm]\ncustom = [\n  ["nested"],\n]\n[other]\nkeep = true\n', table), '[other]\nkeep = true\n\n' + table + '\n');
  const kept = 'list = [\n  [1, 2],\n  { a = "]" },\n]\n[t]\nx = 1';
  assert.equal(withCodexEntry(kept + '\n', table), kept + '\n\n' + table + '\n');
  assert.throws(() => withCodexEntry('a = [\n1,\n', table), /not valid TOML/);
});

test('mlswarm written as an inline table or a dotted key, or an inline mcp_servers table, is refused, not duplicated', () => {
  const table = '[mcp_servers.mlswarm]\nurl = "u"';
  for (const text of ['mcp_servers = { mlswarm = { url = "x" } }\n', 'mcp_servers.mlswarm.url = "x"\n',
    '[mcp_servers]\nmlswarm = { url = "x" }\n', 'mcp_servers = { other = { url = "o" } }\n'])
    assert.throws(() => withCodexEntry(text, table), /does not change/, text);
});

test('an array of mlswarm tables is replaced along with its subtables', () => {
  assert.equal(withCodexEntry('[[mcp_servers.mlswarm]]\nurl = "a"\n[mcp_servers.other]\nurl = "o"\n', '[mcp_servers.mlswarm]\nurl = "u"'),
    '[mcp_servers.other]\nurl = "o"\n\n[mcp_servers.mlswarm]\nurl = "u"\n');
});

test('64-bit integers past 2^53 are valid TOML, and an old mlswarm table after them is still replaced', () => {
  assert.equal(withCodexEntry('big = 9007199254740993\nmask = 0x7FFFFFFFFFFFFFFF\n\n[mcp_servers.mlswarm]\nurl = "old"\n', '[mcp_servers.mlswarm]\nurl = "u"'),
    'big = 9007199254740993\nmask = 0x7FFFFFFFFFFFFFFF\n\n[mcp_servers.mlswarm]\nurl = "u"\n');
});

test('comments above the next table are kept when the mlswarm entry before it is replaced', () => {
  const text = '[mcp_servers.mlswarm]\n# old mlswarm note\ncommand = "old"\n\n# Docs server, added by hand\n[mcp_servers.docs]\nurl = "d"\n';
  assert.equal(withCodexEntry(text, '[mcp_servers.mlswarm]\nurl = "u"'),
    '# Docs server, added by hand\n[mcp_servers.docs]\nurl = "d"\n\n[mcp_servers.mlswarm]\nurl = "u"\n');
  // A comment above a mlswarm subtable is part of the entry and goes with it.
  assert.equal(withCodexEntry('[mcp_servers.mlswarm]\ncommand = "old"\n# env note\n[mcp_servers.mlswarm.env]\nA = "1"\n', '[mcp_servers.mlswarm]\nurl = "u"'),
    '[mcp_servers.mlswarm]\nurl = "u"\n');
});
