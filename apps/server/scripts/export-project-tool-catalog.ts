// The catalog export only initializes SDK registration; it performs no authenticated tool call or database operation.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { serverFor } from '../src/v2/routes.js';
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = serverFor({ id: 'catalog-only', name: 'catalog-only' } as never, undefined, Date.now, () => 0, async () => ({ count: 0, observedAt: 0 }));
const client = new Client({ name: 'catalog-export', version: '1' });
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  console.log(JSON.stringify(await client.listTools(), null, 2));
} finally { await client.close(); await server.close(); }
