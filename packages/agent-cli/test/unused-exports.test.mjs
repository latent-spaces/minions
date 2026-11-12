import test from 'node:test';
import assert from 'node:assert/strict';

// These names are used only inside their own module; keep them private.
const privateNames = {
  '../src/native-worker-adapter.mjs': ['projectUpdateGuidance', 'validateWorkerModelSession'],
  '../src/setup-screen.mjs': ['MESSAGE_START'],
  '../src/run-journal.mjs': ['RUN_JOURNAL_LIMITS'],
  '../src/worker-guidance.mjs': ['validateWorkerGuidance'],
  '../src/context-measurement.mjs': ['CONTEXT_CATEGORIES'],
  '../src/skill-bundle.mjs': ['normalizeSkillText'],
};

test('module-internal helpers are not exported', async () => {
  for (const [path, names] of Object.entries(privateNames)) {
    const module = await import(path);
    for (const name of names) assert.equal(Object.hasOwn(module, name), false, `${path} exports ${name}`);
  }
});
