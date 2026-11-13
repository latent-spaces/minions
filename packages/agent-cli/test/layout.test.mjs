import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectFolder } from '../src/layout.mjs';

test('project folders fold accented letters instead of splitting words at them', () => {
  const root = join('/home', 'mlswarm');
  assert.equal(projectFolder(root, 'a'.repeat(64), 'Crème Brûlée Café', []), join(root, 'projects', 'creme-brulee-cafe'));
  assert.equal(projectFolder(root, 'a'.repeat(64), 'Ångström', []), join(root, 'projects', 'angstrom'));
});

test('a project already placed keeps its folder', () => {
  const root = join('/home', 'mlswarm'), folder = join(root, 'projects', 'cre-me');
  assert.equal(projectFolder(root, 'b'.repeat(64), 'Crème', [{ projectId: 'b'.repeat(64), folder }]), folder);
});

test('project folders never use a Windows device name', () => {
  const root = join('home', 'mlswarm'), projects = join(root, 'projects');
  for (const name of ['CON', 'aux', 'Nul', 'prn', 'COM1', 'lpt9', ' con ']) {
    const folder = projectFolder(root, 'a'.repeat(64), name, []);
    assert.equal(folder, join(projects, `${name.trim().toLowerCase()}-project`), name);
  }
  assert.equal(projectFolder(root, 'a'.repeat(64), 'Console', []), join(projects, 'console'));
  assert.equal(projectFolder(root, 'a'.repeat(64), 'com 1', []), join(projects, 'com-1'));
});
