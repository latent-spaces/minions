import { LEGACY_APP_PATH, legacyAppRedirect, sharedLinkRoutes } from './shared-links.js';
import { realtimeRoutes } from './realtime.js';
import { humanRequestRoutes } from './projects/human-request-routes.js';
import { ownerRoutes, participationSnapshotParser } from './owner/routes.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import express from 'express';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { githubRoutes } from './github/routes.js';
import { platformRoutes } from './platform/routes.js';
import { communityRoutes } from './community/routes.js';
import { publicProfileRoutes } from './community/profile.js';
import { projectManagementRoutes, projectRuntimeRoutes } from './projects/routes.js';
import { humanChatRoutes } from './projects/chat.js';
import { chatMediaRoutes } from './projects/chat-media.js';
import { projectDiscoveryRoutes } from './projects/discovery.js';
import { trustProxySetting } from './trust-proxy.js';
import { projectProgressRoutes } from './projects/progress-routes.js';

// Shared API composition for the hosted entry and the explicit standalone launcher.
// Constructing the app never opens a listener or starts a delivery worker.
export function createApi(host: string, authentication?: express.Router, standaloneOrigin?: () => string): express.Express {
  // Webhook signatures need original bytes, before the SDK's JSON parser. All MCP
  // and human routes keep the SDK's local Host validation and JSON middleware.
  const app = express();
  const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  // Like the private worker, the public API does not advertise its framework. A sub-app mounted at the root
  // sets the header on every request it sees, so the MCP app needs the same setting.
  app.disable('x-powered-by');
  // Baseline security headers on every response (HSTS, nosniff, frame and referrer policy). The page CSP is still an
  // owner decision, and the opener policy still allows popups the viewer opens.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' } }));
  // Private reads, authorization failures and unknown backend routes must not be CDN-cached.
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (standaloneOrigin) app.use((req, res, next) => {
    const origin = standaloneOrigin();
    if (!origin) { res.status(503).json({ message: 'The engine is starting. Try again shortly.' }); return; }
    if (req.headers.host !== new URL(origin).host) { res.status(403).json({ message: 'Use the engine loopback address.' }); return; }
    next();
  });
  app.use('/integrations/github', githubRoutes(Date.now));
  app.use(['/api/owner/participations/sync','/api/owner/backgrounds/sync'], participationSnapshotParser(host));
  // Before the SDK's generic JSON parser: manifests and binary files have their own bounded readers.
  // Standalone authentication supplies its own literal Host/origin checks and bounded JSON parser.
  // Mount before the generic parser so exchange failures keep their small JSON response contract.
  if (authentication) app.use('/api/auth', authentication);
  const mcpApp = createMcpExpressApp({ host });
  mcpApp.disable('x-powered-by');
  app.use(mcpApp);
  app.use(sharedLinkRoutes(Date.now));
  app.use('/community', communityRoutes(Date.now));
  app.use('/api/project-chat', chatMediaRoutes(Date.now));
  app.use('/api/project-chat', humanChatRoutes(Date.now));
  app.use('/api/project-progress', projectProgressRoutes(Date.now));
  app.use('/api/needs-you', humanRequestRoutes(Date.now));
  app.use('/api/realtime', realtimeRoutes());
  app.use('/api/profiles', publicProfileRoutes(Date.now));
  app.use('/api/owner', ownerRoutes(Date.now));
  app.use('/api/platform', platformRoutes(Date.now));
  app.use('/api/discovery/projects', projectDiscoveryRoutes(Date.now));
  app.use('/api/projects', projectManagementRoutes(Date.now));
  app.use('/p/:projectId', projectRuntimeRoutes(Date.now));
  app.get(LEGACY_APP_PATH, legacyAppRedirect);
  // The locally built app, at the root after every API route. fileURLToPath decodes %20 and drops the leading slash before a Windows drive letter.
  app.use(express.static(fileURLToPath(new URL('../../web/dist', import.meta.url))));
  return app;
}
