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
