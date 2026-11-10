import { get } from 'node:http';

// Restart probes must own a fresh connection: pooled sockets can still belong
// to the previous process while it is draining. Consume the response before
// retrying, and bound each attempt independently of the overall startup wait.
export function probeApiRefusal(url, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false, headers: { Connection: 'close' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body = (body + chunk).slice(0, 1000); });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body }));
    });
    // An absolute deadline covers stalled headers/body as well as idle sockets.
    const timer = setTimeout(() => request.destroy(new Error('API readiness probe timed out.')), timeoutMs);
    request.once('close', () => clearTimeout(timer));
    request.once('error', reject);
  });
}
