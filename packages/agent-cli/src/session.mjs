import { defaultSiteStateHome } from './site-state.mjs';
import { canonicalPath, digest } from './state.mjs';
import { projectIdentity } from './project-identity.mjs';
// Fresh model-independent state. Older runner/client configuration records are never migrated.
export const sessionHome = () => canonicalPath(process.env.MINIONS_CREDENTIAL_HOME ?? defaultSiteStateHome('mcp'));
export const sessionId = (service, agentId) => `${digest(service)}/${agentId}`;
export function validateSession(record, id) {
  if (record?.schema !== 'mcp-connection-1' || record.id !== id || record.id !== sessionId(record.service, record.agentId) || !/^[\w-]{1,200}$/.test(record.agentId ?? '') || !/^[\w-]{1,64}$/.test(record.agentName ?? '') || !Number.isFinite(record.approvedAt)) throw new Error('Unsupported or invalid MCP connection record. Create a new connection through Minions; existing records were not changed.');
  const identity = projectIdentity({ projectUrl: record.service, repo: record.repo, folder: record.folder });
  if (identity.projectUrl !== record.service || canonicalPath(record.folder) !== record.folder) throw new Error('Session workspace changed. Review the connection again.');
  return record;
}
