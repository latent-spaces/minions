// This module must stay free of database and API imports: validate before opening any store.
import { deploymentKind } from './deployment.js';
import path from 'node:path';
import { absoluteSelfHostedPath, samePath, selfHostedPaths } from './self-hosted-paths.js';

export function selfHostedConfig(env: NodeJS.ProcessEnv = process.env, paths: Pick<typeof path, 'isAbsolute' | 'resolve'> = path) {
  if (deploymentKind(env) !== 'self-hosted') throw new Error('Standalone startup requires MINIONS_ENGINE=self-hosted.');
  if (env.HOST !== undefined && env.HOST !== '127.0.0.1') throw new Error('The standalone engine currently listens only on HOST=127.0.0.1.');
  if (env.TRUST_PROXY && env.TRUST_PROXY !== 'false') throw new Error('The loopback standalone engine does not accept a trusted proxy.');
  const portText = env.PORT ?? '8787';
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65_535) throw new Error('PORT must be an integer from 0 to 65535.');
  const locations = selfHostedPaths(env, paths);
  // Windows names one file with any letter case or separator, so compare locations rather than spellings.
  if (samePath(locations.sqlitePath, locations.blobRoot, paths)) throw new Error('The database file and media directory need separate paths.');
  const ownerFile = absoluteSelfHostedPath('MINIONS_OWNER_FILE', env.MINIONS_OWNER_FILE, paths);
  if ((samePath(ownerFile, locations.sqlitePath, paths) || samePath(ownerFile, locations.blobRoot, paths))) throw new Error('The owner configuration needs its own private file path.');
  return { ...locations, ownerFile, host: '127.0.0.1', port: Number(portText) } as const;
}
