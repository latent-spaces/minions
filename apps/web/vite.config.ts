import react from '@vitejs/plugin-react';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

// Each build gets an id, baked into the bundle and written to version.json, so an open tab can tell it is out of date.
const build = Date.now().toString(36);

// The built page is served at the root. In development, Vite forwards real API, scoped project and kit paths to the loopback service.
export default defineConfig({
  base: '/',
  define: { __MINIONS_BUILD__: JSON.stringify(build) },
  plugins: [react(), { name: 'minions-build-version', apply: 'build', generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build }) }); } }],
  // Worktrees can share installed dependencies; serve only the resolved font assets in addition to Vite's workspace root.
  server: { host: '127.0.0.1', fs: { allow: [searchForWorkspaceRoot(process.cwd()), dirname(createRequire(import.meta.url).resolve('@fontsource-variable/inter/package.json'))] }, proxy: Object.fromEntries(
    ['/api', '/community', '/p', '/s'].map(path => [`^${path}(?:/|$)`, process.env.KARMA_LOCAL_API_URL ?? 'http://127.0.0.1:8787']),
  ) },
});
