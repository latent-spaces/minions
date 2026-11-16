import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { configuredWebsiteOrigin, selfHostedWebsiteOrigin } from './website-origin.mjs';
import { brandedDirectory } from './brand-paths.mjs';

// 96 bits keep independent installations distinct without long Windows paths.
export const siteInstanceId = site => createHash('sha256').update(site).digest('hex').slice(0, 24);

// Separate defaults preserve the hosted installation and its unfinished work.
// Never migrate approvals, credentials or ledgers when selecting another site.
export function defaultSiteStateHome(kind, env = process.env, userHome = homedir()) {
  if (!['mcp', 'service'].includes(kind)) throw new Error('Unknown private state directory.');
  configuredWebsiteOrigin(env);
  const site = selfHostedWebsiteOrigin(env);
  const root = brandedDirectory(userHome);
  return site === null ? join(root, kind)
    : join(root, 'instances', siteInstanceId(site), kind);
}
