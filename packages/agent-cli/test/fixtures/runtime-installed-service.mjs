import { runInstalledService } from '../../src/service/installation.mjs';
const service = await runInstalledService({ home: process.env.MLSWARM_SERVICE_HOME, site: process.env.MLSWARM_SITE_URL,
  compose: async ({ site }) => ({ principal: { site, ownerId: 'synthetic-owner' }, controllers: { health: async () => ({ ready: true }) },
    application: { listTools: () => [], callTool: async () => { throw new Error('No model or project operations in this fixture.'); } }, close: async () => {} }),
});
process.on('SIGTERM', () => { void service.close(); });
await service.closed;
