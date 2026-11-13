import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { installationHome } from './installation.mjs';
import { VERSION } from '../version.mjs';
import { readRuntimeEndpoint } from './endpoint-file.mjs';

const failure = () => new Error('Shared runtime could not confirm this operation. Inspect runtime status and retry the original request; no fallback was used.');
const parse = result => {
  if (result.isError || !Array.isArray(result.content)) throw failure();
  try { return JSON.parse(result.content.find(item => item.type === 'text').text); } catch { throw failure(); }
};
/** Domain CLI commands share the authenticated MCP application; closing this client never stops missions. */
export function createRuntimeClient({ home = installationHome() } = {}) {
  let client, descriptor, connecting, closing = false;
  async function ready() {
    if (closing) throw failure();
    connecting ??= (async () => {
      descriptor = readRuntimeEndpoint(home);
      client = new Client({ name: 'mlswarm-cli', version: VERSION });
      const endpoint = new URL(descriptor.url);
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${descriptor.token}` }, redirect: 'error' },
        fetch: (url, init) => {
          const selected = new URL(url instanceof Request ? url.url : url);
          if (selected.href !== endpoint.href) throw failure();
          return fetch(url, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
        },
      });
      await client.connect(transport);
    })();
    await connecting;
    if (closing) throw failure();
    const observed = parse(await client.callTool({ name: 'get_computer_status', arguments: {} }));
    for (const key of ['version', 'incarnation', 'pid', 'transport', 'cloudReady']) if (observed[key] !== descriptor.identity[key]) throw failure();
    return client;
  }
  return {
    async callTool(name, args = {}) {
      try {
        const connected = await ready();
        return await connected.callTool({ name, arguments: args });
      } catch { throw failure(); }
    },
    async listTools() {
      try {
        const connected = await ready(), tools = [];
        let cursor;
        do { const page = await connected.listTools(cursor ? { cursor } : {}); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
        return tools;
      } catch { throw failure(); }
    },
    async close() {
      closing = true;
      await connecting?.catch(() => {});
      await client?.close();
    },
  };
}
