// Test-only synthetic adapter. Production controllers know no fixture protocol.
import { StringDecoder } from 'node:string_decoder';
import { prepareSupervisedModel } from '../../src/model-guard.mjs';
// Reads the owner's quoted steering back from the Markdown turn prompt.
function steeringFrom(prompt) {
  const section = prompt.split('\n## Steering from the owner\n\n')[1]?.split('\n## ')[0].trim() ?? '';
  return section.split('\n\n').filter(block => block.startsWith('> ')).map(block => ({ message: block.split('\n').map(line => line.replace(/^> ?/, '')).join('\n') }));
}
export function createFakeAdapterFactory(adapter) {
  return async mission => ({
    async observe() { return { project: { started: true, paused: false }, pending: 0, acknowledged: 0 }; },
    async run({ prompt, signal, onGuardStarted, onGuardClosed, onPromptSubmitted, onTurnStarted }) {
      const steering = steeringFrom(prompt);
      const guard = prepareSupervisedModel({ cwd: adapter.cwd, env: adapter.env, stdio: ['pipe', 'pipe', 'pipe'], deadline: Date.now() + 120000 });
      let result, pending = '', bytes = 0, failure, acknowledged = false, cleanupEvidence = false, writes = Promise.resolve();
      const decoder = new StringDecoder('utf8');
      const fail = error => { failure ??= error; guard.kill('SIGKILL'); };
      const abort = () => guard.kill('SIGKILL'); signal.addEventListener('abort', abort, { once: true });
      guard.on('message', value => { if (value?.cleanupConfirmed === true) cleanupEvidence = true; });
      const closed = new Promise(resolve => {
        guard.once('error', fail);
        guard.once('close', (code, nativeSignal) => resolve({ code, cleanupConfirmed: cleanupEvidence && nativeSignal === null && Number.isInteger(code) }));
      });
      guard.stdout.on('data', chunk => {
        bytes += chunk.length; if (bytes > 65536) return fail(new Error('Native output exceeded limit.'));
        pending += decoder.write(chunk);
        for (;;) {
          const end = pending.indexOf('\n'); if (end < 0) break;
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try {
            const item = JSON.parse(line);
            if (item.type === 'applied') { acknowledged = true; writes = writes.then(() => onTurnStarted()); writes.catch(fail); }
            else if (item.type === 'result' && typeof item.text === 'string' && result === undefined) result = item.text;
            else throw new Error('Invalid fake protocol.');
          } catch (error) { fail(error); }
        }
      });
      guard.stderr.resume(); guard.stdin.on('error', fail);
      try {
        await onGuardStarted(guard.pid);
        if (signal.aborted) abort();
        else {
          const input = JSON.stringify(await adapter.initialInput(mission, steering));
          await onPromptSubmitted();
          if (signal.aborted) abort(); else { guard.authorize(adapter.command, adapter.args); guard.stdin.end(`${input}\n`); }
        }
      } catch (error) { fail(error); }
      const exit = await closed;
      if (exit.cleanupConfirmed) { try { await onGuardClosed?.({ guardPid: guard.pid, cleanupConfirmed: true }); } catch (error) { failure ??= error; } }
      await writes.catch(error => { failure ??= error; }); signal.removeEventListener('abort', abort);
      if (failure) { failure.cleanupConfirmed = exit.cleanupConfirmed; throw failure; }
      const failed = exit.code !== 0 || result === undefined || Boolean(pending.trim());
      return { text: result ?? '', delivery: acknowledged ? 'acknowledged' : 'submitted', failed, interrupted: signal.aborted, retryable: false, cleanupConfirmed: exit.cleanupConfirmed };
    },
  });
}
