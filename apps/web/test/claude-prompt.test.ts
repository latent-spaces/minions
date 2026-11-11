import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudePrompt, DEFAULT_PROMPT_CHOICES } from '../src/ui/claude-prompt';

test('the default choices give the example prompt', () => {
  assert.equal(claudePrompt(DEFAULT_PROMPT_CHOICES), 'Open a private GitHub repo and add 3 Claude Sonnet agents for 5 minutes to build me a 2D game.');
});

test('the prompt follows the repository, agent count and what to build', () => {
  assert.equal(claudePrompt({ visibility: 'public', agents: 1, goal: '  a recipe site. ' }), 'Open a public GitHub repo and add 1 Claude Sonnet agent for 5 minutes to build me a recipe site.');
  assert.equal(claudePrompt({ visibility: 'private', agents: 40, goal: '' }), 'Open a private GitHub repo and add 10 Claude Sonnet agents for 5 minutes to build me a 2D game.');
  assert.equal(claudePrompt({ visibility: 'private', agents: Number.NaN, goal: 'x' }), 'Open a private GitHub repo and add 3 Claude Sonnet agents for 5 minutes to build me x.');
  assert.equal(claudePrompt({ visibility: 'private', agents: 0, goal: 'x' }).includes('add 1 Claude'), true);
});
