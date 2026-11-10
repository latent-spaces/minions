import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { expect, test } from 'vitest';

async function poweredBy(disableOnMcp: boolean) {
  const app = express();
  app.disable('x-powered-by');
  const mcpApp = createMcpExpressApp({ host: '127.0.0.1' });
  if (disableOnMcp) mcpApp.disable('x-powered-by');
  app.use(mcpApp);
  app.get('/after', (_req, res) => { res.send('ok'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const { port } = server.address() as { port: number };
    const headers = (await fetch(`http://127.0.0.1:${port}/after`)).headers;
    return headers.get('x-powered-by');
  } finally { server.close(); }
}

// The engine mounts the MCP app at the root, so its own setting decides the header for every route after it.
test('the root-mounted MCP app must also disable x-powered-by', async () => {
  expect(await poweredBy(false)).toBe('Express');
  expect(await poweredBy(true)).toBeNull();
});
