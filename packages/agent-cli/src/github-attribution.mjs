import { configuredWebsiteOrigin, trustedWebsiteUrl } from './website-origin.mjs';

function id(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Provide the ${label} from the connected MyLittleSwarm identity.`);
  return value;
}

function displayName(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80
    || /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`Provide a single-line ${label} display name.`);
  }
  // Profile invitations can contain a private email as the name. Match the
  // public profile projection rather than publishing that account identifier.
  return value.includes('@') ? label === 'participant' ? 'Participant' : 'Agent' : value.trim();
}

function markdownLabel(value) {
  // Encode ampersands first so entity-shaped names stay literal. GitHub renders
  // these entities as text, including HTML and Markdown punctuation in names.
  return value.replace(/[&<>\[\]\\`*_{}()!|~]/g, character => `&#${character.codePointAt(0)};`);
}

function websiteOrigin(site) {
  let url;
  try { url = new URL(site); } catch { throw new Error('Use a trusted MyLittleSwarm website origin.'); }
  if (!trustedWebsiteUrl(url) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a trusted MyLittleSwarm website origin without paths, credentials, query parameters or fragments.');
  }
  return url.origin;
}

/**
 * Format claimed attribution for a PR description, GitHub comment or review.
 * Callers supply the connected agent and its owning participant's safe display
 * references. This pure helper does not authenticate them or authorize publishing.
 * @param {{projectId: string, agent: {id: string, name: string}, participant: {id: string, name: string}, site?: string}} input
 * @returns {string} A Markdown footer, ready to append after the substantive body.
 */
export function formatGitHubAttribution({ projectId, agent, participant, site = configuredWebsiteOrigin() } = {}) {
  const project = id(projectId, /^[a-f0-9]{64}$/, 'project ID');
  const agentId = id(agent?.id, /^[A-Za-z0-9_-]{1,200}$/, 'agent ID');
  const participantId = id(participant?.id, /^[A-Za-z0-9_-]{1,200}$/, 'participant profile ID');
  const agentName = markdownLabel(displayName(agent?.name, 'agent'));
  const participantName = markdownLabel(displayName(participant?.name, 'participant'));
  const origin = websiteOrigin(site);
  const agentUrl = new URL('/', origin);
  agentUrl.search = new URLSearchParams({ project, section: 'agents', agent: agentId }).toString();
  const profileUrl = new URL('/', origin);
  profileUrl.search = new URLSearchParams({ view: 'profile', person: participantId }).toString();
  return `---\nAI-generated contribution by MyLittleSwarm agent [${agentName}](${agentUrl.href}) · Participant: [${participantName}](${profileUrl.href}).\nAttribution does not imply human review or approval.`;
}

/** Prepare attribution from the authenticated own-agent context, never a viewer or roster name. */
export function attributionFromProjectContext(value, site = configuredWebsiteOrigin()) {
  const you = value?.you, identity = you?.participation?.identity;
  if (!identity || you.agentId !== identity.agentId) throw new Error('Read the connected agent’s own project identity before publishing.');
  return formatGitHubAttribution({ projectId: identity.projectId,
    agent: { id: identity.agentId, name: you.agentName },
    participant: { id: identity.profileId, name: you.operatorName }, site });
}
