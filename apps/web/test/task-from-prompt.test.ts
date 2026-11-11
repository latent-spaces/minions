import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskFromPrompt } from '../src/task-model';

test('a one-line prompt is the whole title', () => {
  assert.deepEqual(taskFromPrompt('  Fix the login button  '), { title: 'Fix the login button', description: '' });
});

test('the first line is the title and the rest the description', () => {
  assert.deepEqual(taskFromPrompt('Fix login\n\nIt fails on Safari.\nSee the log.'), { title: 'Fix login', description: 'It fails on Safari.\nSee the log.' });
});

test('a long first line is shortened at a word and the whole text kept as the description', () => {
  const text = `${'word '.repeat(40).trim()}\nmore`;
  const { title, description } = taskFromPrompt(text);
  assert.ok(title.length <= 121 && title.endsWith('…') && !title.includes('wor…'));
  assert.equal(description, text);
});
