import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectFolder } from '../src/layout.mjs';

test('project folders never use a Windows device name', () => {
  const root = join('home', 'mlswarm'), projects = join(root, 'projects');
  for (const name of ['CON', 'aux', 'Nul', 'prn', 'COM1', 'lpt9', ' con ']) {
    const folder = projectFolder(root, 'a'.repeat(64), name, []);
    assert.equal(folder, join(projects, `${name.trim().toLowerCase()}-project`), name);
  }
  assert.equal(projectFolder(root, 'a'.repeat(64), 'Console', []), join(projects, 'console'));
  assert.equal(projectFolder(root, 'a'.repeat(64), 'com 1', []), join(projects, 'com-1'));
});
