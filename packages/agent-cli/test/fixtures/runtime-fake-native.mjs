// Synthetic native protocol peer: never imports a provider or contacts a model.
import { readFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const data = JSON.parse(input);
if (data.events) appendFileSync(data.events, `${JSON.stringify({ type: 'start', pid: process.pid, steering: data.steering })}\n`);
if (data.childPidFile) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const { writeFileSync } = await import('node:fs'); writeFileSync(data.childPidFile, String(child.pid));
}
if (data.gate) {
  while (true) { try { if (readFileSync(data.gate, 'utf8') === 'go') break; } catch {} await new Promise(resolve => setTimeout(resolve, 10)); }
}
if (!data.noAck) process.stdout.write(`${JSON.stringify({ type: 'applied' })}\n`);
if (data.hangAfterAck) await new Promise(() => setInterval(() => {}, 1000));
if (data.invalid) process.stdout.write('invalid protocol\n');
else process.stdout.write(`${JSON.stringify({ type: 'result', text: data.steering.length ? `Followed: ${data.steering.map(item => item.message).join('; ')}` : 'Synthetic first turn complete.' })}\n`);
