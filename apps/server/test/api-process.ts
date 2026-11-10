// Test-only API process for browser and process tests: the engine's API and GitHub sessions on the disposable test
// session's shared store, without its worker. Start it with `--import tsx` and PORT; it listens on 127.0.0.1.
import express from 'express';
import { deploymentKind } from '../src/deployment.js';

if (deploymentKind() !== 'test' || !process.env.MLSWARM_TEST_SQLITE_PATH) throw new Error('The test API process runs only inside a disposable test session with a shared store.');
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Set PORT for the test API process.');
const [{ createApi }, { identity, setIdentityProvider }, { endSession, serverSessionIdentity }, { sessionRoutes }, { drainProjectControl }] = await Promise.all([
  import('../src/api.js'), import('../src/identity/index.js'), import('../src/identity/server-sessions.js'),
  import('../src/identity/session-routes.js'), import('../src/projects/project-control.js')]);
setIdentityProvider(serverSessionIdentity());
const authentication = express.Router();
authentication.use(sessionRoutes(identity, endSession));
const server = createApi('127.0.0.1', authentication).listen(port, '127.0.0.1', error => {
  if (error) throw error;
  console.info(`Listening on http://127.0.0.1:${port}`);
});

// Closing the server lets open requests finish; held project-control requests answer now instead of being reset.
function shutDown(): void {
  drainProjectControl();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', shutDown);
process.on('SIGINT', shutDown);
