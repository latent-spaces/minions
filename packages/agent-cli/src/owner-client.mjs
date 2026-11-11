import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { validRunMinutes } from './run-length.mjs';
import { dirname, join, isAbsolute } from 'node:path';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { assertStateOutsideWorkspace, canonicalPath, connectionDir, ensureHome, privateDir, readPrivate, writePrivate, lstatExists, digest, save as saveConnection } from './state.mjs';
import { sessionHome, sessionId, validateSession } from './session.mjs';
import { projectIdentity } from './project-identity.mjs';
import { withOperationLock } from './operation-lock.mjs';
import { layout, projectFolder, workspaceHome } from './layout.mjs';
import { isGithubRepositoryUrl } from './github-repository.mjs';
import { configuredWebsiteOrigin, trustedWebsiteUrl } from './website-origin.mjs';
import { OWNER_TOOLS } from './owner-tools.mjs';
import { z } from 'zod/v4';

const OWNER_SCHEMAS = new Map(OWNER_TOOLS.map(tool => [tool.name, tool.inputSchema]));

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const TOKEN = /^[\w-]{43}$/;
const ID = /^[a-f0-9]{64}$/;
const PROFILE = /^[A-Za-z0-9_-]{1,200}$/;
// List tools return short rows, 20 at a time; detail: true returns the server's full rows
// (owner direction, 9 November 2026, docs/decisions.md).
const LIST_PAGE_DEFAULT = 20;
const start = text => typeof text === 'string' ? [...text].slice(0, 80).join('') : text;
const rows = (key, row) => page => Array.isArray(page?.[key]) ? { ...page, [key]: page[key].map(row) } : page;
const LEAN = {
  list_my_projects: rows('projects', p => ({ id: p.id ?? p.projectId, name: p.name ?? p.title })),
  list_my_proposals: rows('proposals', ({ id, title, status }) => ({ id, title, status })),
  list_needs_you: rows('items', ({ id, projectTitle, title, status, revision }) => ({ id, projectTitle, title, status, revision })),
  list_project_agents: rows('agents', ({ agentId, name, operatorName, sameOperator, state }) => ({ agentId, name, operatorName, sameOperator, state })),
  list_project_conversations: rows('conversations', ({ threadId, count, first }) => ({
    threadId, summary: first?.summary || start(first?.body), from: first?.sender?.name,
    to: first?.audience?.kind === 'direct' ? first.audience.to?.map(to => to.name) : first?.audience?.kind, messages: count })),
  read_project_updates: rows('items', u => ({ id: u.id, title: u.title ?? start(u.body), author: u.author?.agent?.name ?? u.author?.profile?.name, publishedAt: u.publishedAt })),
  list_project_tasks: rows('tasks', ({ id, title, status, assignedAgentId }) => ({ id, title, status, assignedAgentId })),
};
const UUID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
export function ownerOrigin(site) {
  const u = new URL(site ?? configuredWebsiteOrigin());
  if (!trustedWebsiteUrl(u) || u.search || u.hash || u.pathname !== '/') throw new Error('Owner management requires the MyLittleSwarm website, enrolled self-hosted origin or explicit loopback development origin.');
  return u.origin;
}
export function createOwnerClient({ home = sessionHome(), workspace = workspaceHome(), site, fetchImpl = fetch, now = Date.now } = {}) {
  const origin = ownerOrigin(site); home = canonicalPath(home); workspace = canonicalPath(workspace);
  function directory() { ensureHome(home); const root = join(home, 'owners'); privateDir(root); const dir = join(root, digest(origin)); privateDir(dir); return dir; }
  function receipt() {
    const p = join(directory(), 'owner.json'); if (!lstatExists(p)) return null;
    const r = readPrivate(p, true);
    if (r.schema !== 'mlswarm-owner-1' || r.origin !== origin || !/^[a-f0-9-]{36}$/.test(r.requestId ?? '') || !TOKEN.test(r.pollingSecret ?? '') || !TOKEN.test(r.token ?? '') || !['pending','approved','expired','cancelled','revoked'].includes(r.status)) throw new Error('Owner connection state is invalid. No credentials were changed.');
    return r;
  }
  const save = r => writePrivate(join(directory(), 'owner.json'), r);
  // A website path the service returned, as a full link on this website; anything else is no link.
  const siteUrl = path => typeof path === 'string' && /^\/[^/\\]/.test(path) && !path.includes('\\') ? new URL(path, origin).href : null;
  // The one check behind every action that needs this computer's approval. It answers with the saved
  // approval, or stops with the same instruction whether the computer was never approved or its approval
  // ran out or was ended on My agents.
  const NOT_APPROVED = `This computer is not approved for MyLittleSwarm, or its approval has ended. Call approve_this_computer: your human approves this computer once in the browser, then repeat this call. Setup instructions: ${new URL('/viewer/?view=agents', origin).href}`;
  function approved() {
    const r = receipt();
    if (!r || r.status !== 'approved' || r.connectionExpiresAt <= now()) throw new Error(NOT_APPROVED);
    return r;
  }
  function selectedAccount(expectedProfileId) {
    const r = approved();
    if (expectedProfileId !== undefined && (!PROFILE.test(expectedProfileId ?? '') || r.personId !== expectedProfileId)) throw new Error('This computer is now approved for a different MyLittleSwarm account. Call approve_this_computer to check which account it uses, then try again with the same request.');
    return r;
  }
  async function request(path, { method = 'GET', body, token, poll, profileId, signal, responseLimit = 256 * 1024 } = {}) {
    let response;
    try { response = await fetchImpl(new URL('/api/owner' + path, origin), { method, redirect: 'error', credentials: 'omit', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { Accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(poll ? { Authorization: `Bearer ${poll}` } : {}), ...(profileId ? { 'X-Mlswarm-Profile-Id': profileId } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new Error('MyLittleSwarm can’t be reached right now. Try the same request again in a moment.'); }
    let size = 0, chunks = [];
    for await (const c of response.body) { size += c.byteLength; if (size > responseLimit) { await response.body.cancel?.().catch(() => {}); throw new Error('MyLittleSwarm sent back an unexpected reply. Try again in a moment.'); } chunks.push(c); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('MyLittleSwarm sent back an unexpected reply. Try again in a moment.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('MyLittleSwarm sent back an unexpected reply. Try again in a moment.');
    if (!response.ok) {
      const detail = response.status < 500 && typeof data.message === 'string' && data.message.length <= 500 && !/[\x00-\x1f\x7f-\x9f]/.test(data.message) ? data.message : null;
      // The service no longer accepts this computer's approval: remember that, so the next call asks for a new one.
      // Any other refusal, such as a project the person does not belong to, leaves the approval as it is.
      if (response.status === 401 && token && /^This computer approval /.test(data.message ?? '')) { const r = receipt(); if (r?.token === token && r.status === 'approved') save({ ...r, status: 'revoked' }); throw new Error(NOT_APPROVED); }
      const failure = new Error(detail ? `Owner operation refused: ${detail}` : 'MyLittleSwarm couldn’t do that. Check the current state, then try again.');
      // Keep permanent project refusals distinguishable from transport failures.
      // Retryable HTTP responses cannot retire a saved control, even if their
      // body happens to carry a permanent-looking error code.
      if (response.status < 500 && ![408,429].includes(response.status)
        && typeof data.error === 'string' && /^[a-z_]{1,80}$/.test(data.error)) { failure.code = data.error; failure.refusal = true; }
      failure.httpStatus = response.status;
      const retry = Number(response.headers.get('Retry-After'));
      failure.retryAfterSeconds = Number.isFinite(retry) && retry > 0 ? Math.min(60, retry) : 10;
      // A reached limit says which one, so the agent can tell the person instead of retrying.
      const l = data.limit;
      if (failure.code === 'limit_reached' && l && ['agents_per_participant','private_participants'].includes(l.scope) && Number.isSafeInteger(l.limit) && Number.isSafeInteger(l.used)) failure.limit = { scope: l.scope, limit: l.limit, used: l.used };
      throw failure;
    }
    return data;
  }
  function publicState(r) {
    const url = new URL('/viewer/', origin); url.searchParams.set('view','owner-connect'); url.searchParams.set('request',r.requestId);
    if (/^\/s\/[A-Za-z0-9_-]{22}$/.test(r.approvalPath ?? '')) url.href = new URL(r.approvalPath, origin).href;
    return { website_origin: origin, environment: new URL(origin).protocol === 'http:' ? 'local-development' : 'live', status: r.status, account_name: r.personName ?? null, account_profile_id: r.status === 'approved' && PROFILE.test(r.personId ?? '') ? r.personId : null, expires_at: r.connectionExpiresAt ?? r.expiresAt ?? null, ...(r.status === 'pending' ? { approval_url: url.href, request_check: r.verificationCode, next_step: 'Show the person the approval link and check code. They sign in and approve this computer once; then call check_computer_approval.' } : {}) };
  }
  async function connect(clientName = 'MyLittleSwarm CLI', expectedWebsite) {
    if (expectedWebsite !== undefined && ownerOrigin(expectedWebsite) !== origin) throw new Error(`MyLittleSwarm website mismatch: this connector uses ${origin}, but setup requested ${ownerOrigin(expectedWebsite)}. Do not approve a link for the other environment. Check MLSWARM_SELF_HOSTED_ORIGIN and MLSWARM_SITE_URL, then run mcp-config --site for the requested website and reload only when agents are idle.`);
    return withOperationLock(directory(), async () => {
      let r = receipt();
      if (r?.status === 'approved' && r.connectionExpiresAt > now()) return publicState(r);
      if (!r || ['expired','cancelled','revoked','approved'].includes(r.status)) { r = { schema:'mlswarm-owner-1', origin, requestId:randomUUID(), pollingSecret:randomBytes(32).toString('base64url'), token:randomBytes(32).toString('base64url'), clientName, status:'pending' }; save(r); }
      const response = await request('/connect', { method:'POST', body:{ requestId:r.requestId, pollingSecret:r.pollingSecret, candidateTokenHash:hash(r.token), clientName:r.clientName } });
      if (response.requestId !== r.requestId || !['pending','approved','expired','cancelled'].includes(response.status)) throw new Error('Owner service returned an invalid connection response. Retry this saved request.');
      r = { ...r, status:response.status === 'approved' ? 'pending' : response.status, expiresAt:response.expiresAt, verificationCode:response.verificationCode, approvalPath:response.approvalPath }; save(r);
      return publicState(r);
    });
  }
  async function finish() {
    return withOperationLock(directory(), async () => {
      const r = receipt(); if (!r) throw new Error('Owner connection has not been requested. Connect your human account first.');
      if (r.status === 'approved' && r.connectionExpiresAt > now()) return publicState(r);
      const response = await request(`/connect/${r.requestId}`, { poll:r.pollingSecret });
      if (!['pending','approved','expired','cancelled'].includes(response.status) || response.status === 'approved' && (!Number.isFinite(response.connectionExpiresAt) || response.connectionExpiresAt <= now() || typeof response.personName !== 'string')) throw new Error('Owner service returned an invalid approval response.');
      const saved = { ...r, ...response }; save(saved); return publicState(saved);
    });
  }
  async function operation(name, args, { expectedProfileId, signal } = {}) {
    const r = selectedAccount(expectedProfileId);
    const e = value => encodeURIComponent(value ?? ''), project = `/projects/${e(args.project_id)}`;
    const specs = { list_working_agents:[`${project}/my-workers`], list_needs_you:['/needs-you'], answer_human_request:[`/needs-you/${e(args.request_id)}/answer`,'POST'], set_project_update_settings:[`${project}/project-update-settings`,'POST'], get_project_overview:[`${project}/overview`], list_project_agents:[`${project}/agents`], list_project_conversations:[`${project}/conversations`], read_project_conversation:[`${project}/conversations/${e(args.thread_id)}`], read_project_chat:[`${project}/chat`], read_project_updates:[`${project}/updates`], list_project_tasks:[`${project}/tasks`], read_project_task:[`${project}/tasks/${e(args.task_id)}`], update_project_card:[`${project}/card`,'POST'], set_project_repository:[`${project}/configure`,'POST'], publish_to_explore:[`${project}/publish`,'POST'], make_project_public:[`${project}/public-conversion`,'POST'], create_private_project:['/projects/private','POST'], set_agent_limits:[`${project}/agents/${e(args.agent_id)}/settings`,'POST'], register_my_agents:[`${project}/agents`,'POST'], list_my_projects:['/projects'], list_my_proposals:['/proposals'], get_my_proposal:[`/proposals/${e(args.project_id)}`], control_project:[`${project}/control`,'POST'], archive_my_project:[`${project}/personal-archive`,'POST'], end_computer_approval:['/connections/revoke','POST'] };
    if (!specs[name]) throw new Error('Owner operation is unknown.');
    const schema = OWNER_SCHEMAS.get(name);
    if (schema.required.includes('project_id') && !ID.test(args.project_id ?? '')) throw new Error('Use the project’s ID from list_my_projects.');
    if (Object.keys(args).some(k=>!Object.hasOwn(schema.properties,k))) throw new Error('This tool doesn’t take one of these fields; use only the documented ones.');
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > (schema.properties.cursor.maxLength ?? 500))) throw new Error('Use the cursor from the previous page.');
    // An approved change is saved on this computer before MyLittleSwarm hears of it, so a retry after a lost
    // reply comes from the same account with the same input.
    const recorded = (requestId, input, path, body) => withOperationLock(directory(), async () => {
      const account = selectedAccount(expectedProfileId);
      if (!PROFILE.test(account.personId ?? '')) throw new Error('Reconnect your human account before changing project setup.');
      const intents = join(directory(), 'project-management'); privateDir(intents);
      const file = join(intents, digest(name + ':' + requestId) + '.json'), fingerprint = hash(canonical(input));
      const intent = lstatExists(file) ? readPrivate(file, true) : null;
      if (intent && (intent.profileId !== account.personId || intent.fingerprint !== fingerprint)) throw new Error('Retry this action with its original human account and unchanged input.');
      if (!intent) writePrivate(file, { profileId:account.personId, fingerprint });
      return request(path, { method:'POST', body, token:account.token, profileId:account.personId });
    });
    if (name === 'create_private_project') {
      if (args.approved !== true || typeof args.title !== 'string' || !args.title.trim() || args.title.trim().length > 120 || typeof args.goal !== 'string' || !args.goal.trim() || args.goal.trim().length > 1500 || typeof args.repoUrl !== 'string' || !isGithubRepositoryUrl(args.repoUrl) || !UUID.test(args.client_request_id ?? '')) throw new Error('Owner private creation requires approval of the name, purpose and GitHub repository and the original request UUID.');
      const body = { client_request_id: args.client_request_id, title: args.title.trim(), goal: args.goal.trim(), githubUrl: args.repoUrl, approved: true };
      // Save before contact, so an uncertain write never becomes another person's
      // project after this computer is approved under a different account.
      return withOperationLock(directory(), async () => {
        const account = selectedAccount(expectedProfileId);
        if (!PROFILE.test(account.personId ?? '')) throw new Error('Owner account identity is missing. End this computer approval and connect again before creating a private project.');
        const intents = join(directory(), 'private-projects'); privateDir(intents);
        const path = join(intents, `${digest(body.client_request_id)}.json`);
        const fingerprint = hash(JSON.stringify(body));
        const saved = lstatExists(path) ? readPrivate(path, true) : null;
        if (saved && (saved.schema !== 'mlswarm-private-creation-1' || saved.fingerprint !== fingerprint || saved.profileId !== account.personId)) throw new Error('Owner private creation must retain its original account, name, purpose, repository and request UUID. Review that original request; do not replace it automatically.');
        if (!saved) writePrivate(path, { schema: 'mlswarm-private-creation-1', profileId: account.personId, fingerprint, input: { client_request_id: body.client_request_id, title: body.title, goal: body.goal, repoUrl: body.githubUrl } });
        const created = await request('/projects/private', { method: 'POST', body, token: account.token, profileId: account.personId });
        if (!ID.test(created.id ?? '') || created.projectId !== created.id || created.startsAgents !== false || created.messageProtection !== 'server_readable_v1') throw new Error('Owner service returned an invalid private creation response. Retry the same request.');
        return { ...created, project_page_url: siteUrl(created.projectPagePath) ?? new URL(`/viewer/?project=${created.id}`, origin).href };
      });
    }
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new Error('Choose a page size from 1 to 100.');
    if (args.detail !== undefined && typeof args.detail !== 'boolean') throw new Error('Set detail to true for full rows, or leave it out.');
    const listed = LEAN[name];
    if (listed || ['read_project_conversation','read_project_chat'].includes(name)) args = { ...args, limit: args.limit ?? LIST_PAGE_DEFAULT };
    const lean = response => listed && args.detail !== true ? listed(response) : response;
    if (name === 'list_needs_you') {
      if (args.project_id !== undefined && !ID.test(args.project_id) || args.status !== undefined && !['open','answered','resolved'].includes(args.status)) throw new Error('Choose a valid project and Needs you status.');
      const params = new URLSearchParams();
      for (const field of ['project_id','status','cursor','limit']) if (args[field] !== undefined) params.set(field,args[field]);
      return lean(await request('/needs-you?' + params,{token:r.token,profileId:r.personId}));
    }
    if (name === 'answer_human_request') {
      const indices=args.option_indices;
      if (args.body !== undefined && typeof args.body !== 'string') throw new Error('Write the optional note as text.');
      if (indices !== undefined && (!Array.isArray(indices) || indices.length>3 || new Set(indices).size!==indices.length || indices.some(index=>!Number.isInteger(index)||index<0||index>2))) throw new Error('Choose distinct option_indices from zero to two.');
      if (args.custom_answer !== undefined && (typeof args.custom_answer !== 'string' || !args.custom_answer.trim() || args.custom_answer.trim().length>2000)) throw new Error('Write a custom answer of up to 2000 characters.');
      if (args.option_index !== undefined && (indices !== undefined || args.custom_answer !== undefined)) throw new Error('Use the current selection format or the legacy option_index, not both.');
      if ((args.body?.trim().length ?? 0)+(args.custom_answer?.trim().length ?? 0)>2000) throw new Error('Keep the answer and note within 2000 characters combined.');
      if (args.approved !== true || !ID.test(args.request_id ?? '') || !Number.isSafeInteger(args.expected_revision) || args.expected_revision < 1 || !/^[\w-]{1,64}$/.test(args.client_request_id ?? '') || (args.body !== undefined && (typeof args.body !== 'string' || args.body.trim().length > 2000)) || (args.option_index !== undefined && (!Number.isInteger(args.option_index) || args.option_index < 0 || args.option_index > 2)) || (args.option_index === undefined && !indices?.length && !args.custom_answer?.trim() && !args.body?.trim())) throw new Error('Answer with the human-approved option or text, current revision and original request ID.');
      return withOperationLock(directory(),async () => {
        const account=selectedAccount(expectedProfileId), body={expected_revision:args.expected_revision,client_request_id:args.client_request_id,body:args.body?.trim() ?? '',...(args.option_index !== undefined ? {option_index:args.option_index} : {}),...(indices !== undefined ? {option_indices:indices.slice().sort((a,b)=>a-b)} : {}),...(args.custom_answer !== undefined ? {custom_answer:args.custom_answer.trim()} : {}),approved:true};
        const intents=join(directory(),'human-answers'); privateDir(intents);
        const path=join(intents,digest(body.client_request_id)+'.json'), fingerprint=hash(canonical({request_id:args.request_id,body}));
        const saved=lstatExists(path) ? readPrivate(path,true) : null;
        if (saved && (saved.profileId !== account.personId || saved.fingerprint !== fingerprint)) throw new Error('Retry the original human answer under its original account.');
        if (!saved) writePrivate(path,{profileId:account.personId,fingerprint});
        return request(`/needs-you/${args.request_id}/answer`,{method:'POST',body,token:account.token,profileId:account.personId});
      });
    }
    if (name === 'make_project_public') {
      if (args.confirm_public_chat !== true || args.confirm_public_joining !== true
        || !['expected_revision','expected_card_version','expected_listing_revision','expected_community_revision'].every(key => Number.isSafeInteger(args[key]) && args[key] >= (['expected_card_version','expected_community_revision'].includes(key) ? 1 : 0))
        || typeof args.summary !== 'string' || !args.summary.trim() || args.summary.trim().length > 240
        || !['games','developer-tools','personal-tools','research','creative','community'].includes(args.category)
        || !Array.isArray(args.tags) || args.tags.length > 5 || args.tags.some(tag => typeof tag !== 'string' || !/^[a-z0-9-]{1,24}$/.test(tag))) {
        throw new Error('Review the current project, listing and chat revisions; explicitly approve public human chat and public-project joining.');
      }
    }
    const setupMutations = ['update_project_card','set_project_repository','publish_to_explore','make_project_public'];
    if (setupMutations.includes(name)) {
      if (args.approved !== true || !/^[\w-]{1,64}$/.test(args.client_request_id ?? '') || !ID.test(args.project_id ?? '')) throw new Error('Review the exact project changes and retain their original request ID before approving.');
      const { project_id, ...body } = args;
      return recorded(body.client_request_id, { name, project_id, body }, specs[name][0], body);
    }
    if ((args.thread_id !== undefined || args.task_id !== undefined) && !/^[\w-]{1,200}$/.test(args.thread_id ?? args.task_id)) throw new Error('Use the ID from the list this came from.');
    if (args.q !== undefined && (typeof args.q !== 'string' || !args.q.trim() || args.q.length > 64 || /[\x00-\x1f\x7f-\x9f]/.test(args.q))) throw new Error('Filter by up to 64 characters of an agent\'s name.');
    if (args.source !== undefined && !['authored_updates','result_history'].includes(args.source)) throw new Error('Choose authored_updates or result_history.');
    let [path,method = 'GET'] = specs[name], body;
    if (name === 'control_project' || name === 'archive_my_project') {
      if (args.approved !== true || !Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0 || !/^[\w-]{1,64}$/.test(args.client_request_id ?? '')) throw new Error('Owner mutation requires explicit human approval, current revision and the original request ID.');
      body = { expected_revision:args.expected_revision, client_request_id:args.client_request_id };
      if (name === 'control_project') {
        if (!['start','pause','resume','add_time','set_tokens','close','reopen'].includes(args.action)) throw new Error('Choose start, pause, resume, add_time, set_tokens, close or reopen.');
        if (args.action === 'add_time' ? !validRunMinutes(args.minutes) : args.minutes !== undefined && (args.action !== 'start' || !validRunMinutes(args.minutes))) throw new Error('Minutes belong to start or add_time: 5 minutes to 24 hours in 5-minute steps.');
        if (args.start_without_minimum !== undefined && (args.action !== 'start' || typeof args.start_without_minimum !== 'boolean')) throw new Error('The minimum override belongs only to an explicitly approved start.');
        if (args.action === 'set_tokens' ? !(args.tokens === null || Number.isSafeInteger(args.tokens) && args.tokens > 0)
          : args.tokens !== undefined) throw new Error('tokens belong to set_tokens: a positive whole number of tokens, or null for no cap.');
        body.action = args.action; body.approved = true;
        if (args.minutes !== undefined) body.minutes = args.minutes;
        if (args.tokens !== undefined) body.tokens = args.tokens;
        if (args.start_without_minimum !== undefined) body.start_without_minimum = args.start_without_minimum;
      }
      else if (name === 'archive_my_project') {
        if (typeof args.archived !== 'boolean') throw new Error('Choose archived true to archive or false to restore.');
        body.archived = args.archived; body.approved = true;
      }
    }
    if (name === 'set_project_update_settings') {
      if (args.approved !== true || !['brief','detailed'].includes(args.writing_style) || !Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0 || !/^[\w-]{1,64}$/.test(args.client_request_id ?? '')) throw new Error('Changing Project update writing style requires the human-selected style, approval, saved revision and original request ID.');
      if (args.additional_instructions !== undefined && (typeof args.additional_instructions !== 'string' || [...args.additional_instructions].length > 4000)) throw new Error('Additional update instructions must be text of at most 4000 characters.');
      body = { expectedRevision: args.expected_revision, clientRequestId: args.client_request_id, writingStyle: args.writing_style, ...(args.additional_instructions !== undefined ? { additionalInstructions: args.additional_instructions } : {}) };
    }
    if (name === 'set_agent_limits') {
      if (!ID.test(args.project_id ?? '') || !/^[\w-]{1,200}$/.test(args.agent_id ?? '') || !['with_me','on_own'].includes(args.involvement)) throw new Error('Owner work settings need the exact project and agent IDs and an involvement of with_me or on_own.');
      body = { involvement:args.involvement };
    }
    if (name === 'register_my_agents') {
      if (args.approved !== true || !/^[\w-]{1,64}$/.test(args.client_request_id ?? '') || !Array.isArray(args.names) || args.names.length < 1 || args.names.length > 10 || new Set(args.names).size !== args.names.length || args.names.some(n => typeof n !== 'string' || !/^[\w-]{1,64}$/.test(n))) throw new Error('Owner team registration requires approved distinct names and the original request ID.');
      body = { names:args.names,client_request_id:args.client_request_id,approved:true };
    }
    if (name === 'end_computer_approval') body = {};
    if (name === 'list_my_projects' && args.scope !== undefined && !['owned','joined','all'].includes(args.scope)) throw new Error('Choose owned, joined or all projects.');
    const query = new URLSearchParams();
    for (const field of ['cursor','scope','q','source','limit']) if (args[field] !== undefined) query.set(field, String(args[field]));
    if (query.size) path += '?' + query;
    const response = await request(path,{method,body,token:r.token,profileId:r.personId});
    if (name === 'end_computer_approval') save({...r,status:'revoked'});
    // The goal is already in definition.goal.
    if (name === 'get_project_overview' && response.project && typeof response.project === 'object') delete response.project.mission;
    return lean(response);
  }
  // The projects the human belongs to, by name.
  async function memberProjects(token) {
    const projects = [];
    for (let cursor, pages = 0; pages < 10; pages++) {
      const page = await request('/member-projects' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { token });
      if (!Array.isArray(page.projects)) throw new Error('MyLittleSwarm sent back an unexpected reply. Try again in a moment.');
      projects.push(...page.projects.filter(p => ID.test(p?.projectId ?? '') && typeof p.projectName === 'string'));
      if (!(cursor = page.next)) break;
    }
    return projects;
  }
  // The project the human named. Punctuation and case are ignored, and a shorter name is accepted when it
  // fits exactly one project.
  async function namedProject(name, token) {
    const plain = value => String(value).normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(), wanted = plain(name), projects = await memberProjects(token);
    const exact = wanted ? projects.filter(p => plain(p.projectName) === wanted) : [], found = exact.length ? exact : wanted ? projects.filter(p => plain(p.projectName).includes(wanted)) : [];
    if (found.length === 1) return found[0];
    const names = (found.length ? found : projects).map(p => `“${p.projectName}”`).join(', ');
    throw new Error(found.length ? `Several of your projects match that name: ${names}. Ask which one.` : `None of your projects is called that. Your projects: ${names || 'none yet; join one on MyLittleSwarm first'}.`);
  }
  // Every agent connection saved on this computer, read from its private records.
  function savedAgents() {
    const found = [];
    if (!lstatExists(home)) return found;
    for (const project of readdirSync(home)) {
      if (!ID.test(project)) continue;
      for (const agent of readdirSync(join(home, project))) {
        const dir = join(home, project, agent);
        if (!lstatExists(join(dir, 'connection.json')) || !lstatExists(join(dir, 'token'))) continue;
        const record = readPrivate(join(dir, 'connection.json'), true), token = readPrivate(join(dir, 'token'));
        if (record?.schema === 'mcp-connection-1' && typeof record.folder === 'string' && TOKEN.test(token)) found.push({ record, token });
      }
    }
    return found;
  }
  // The project's folder in the fixed layout, named after the project. The agent's own folder inside it,
  // <agent>-<id>, is known once the service has answered with the agent's ID.
  async function placedProject(projectId, service, token, saved, projectName) {
    const projects = layout(workspace).projects, inside = folder => dirname(dirname(folder)) === projects;
    const placed = saved.filter(s => inside(s.record.folder)).map(s => ({ projectId: s.record.service === service ? projectId : s.record.service, folder: dirname(s.record.folder) }));
    projectName ??= (await memberProjects(token)).find(p => p.projectId === projectId)?.projectName;
    if (typeof projectName !== 'string') throw new Error('You aren’t a member of this project, so nothing was saved.');
    const folder = projectFolder(workspace, projectId, projectName, placed);
    mkdirSync(folder, { recursive: true }); mkdirSync(layout(workspace).main, { recursive: true });
    return folder;
  }
  // The credential is generated here and saved before the service hears of it, so a lost reply is
  // retried with the same credential and the service answers it as the same connection.
  // exact: the agent's ID, when the caller names an existing agent. own: the folder is the agent's own checkout.
  async function addAgent(args, clientName = 'MyLittleSwarm CLI', { exact, own = true, expectedProfileId, webStartId } = {}) {
    if (webStartId !== undefined && !UUID.test(webStartId)) throw new Error('Web starts require their original request UUID.');
    const r = selectedAccount(expectedProfileId);
    const named = args.project_id === undefined && typeof args.project_name === 'string' && args.project_name.trim() && args.project_name.length <= 500 ? await namedProject(args.project_name, r.token) : null;
    if (named) args = { ...args, project_id: named.projectId };
    if (Object.keys(args).some(k => !['project_id','project_name','agent_name','folder'].includes(k)) || !ID.test(args.project_id ?? '') || !/^[\w-]{1,64}$/.test(args.agent_name ?? '') || (args.folder !== undefined && (typeof args.folder !== 'string' || !isAbsolute(args.folder)))) throw new Error('Adding an agent needs the project’s name or exact ID and a short agent name; a folder, when given, must be absolute.');
    const service = projectIdentity({ projectUrl: new URL(`/p/${args.project_id}`, origin).href, folder: workspace }).projectUrl;
    const adds = join(directory(), 'adds'); privateDir(adds);
    const path = join(adds, `${digest([args.project_id, args.agent_name, ...(webStartId ? [webStartId] : [])])}.json`);
    const once = async (known, saved) => {
      let add = lstatExists(path) ? readPrivate(path, true) : null;
      if (add && add.profileId !== r.personId) throw new Error('Retry this unfinished agent request with its original human account. No credentials were changed.');
      if (add && (add.projectId !== args.project_id || add.name !== args.agent_name || !TOKEN.test(add.candidateToken ?? ''))) throw new Error('Saved agent request is invalid. No credentials were changed.');
      // An agent this computer already connected keeps its folder and its saved credential, so picking it
      // up again in a new conversation changes nothing and the service answers it as the same connection.
      // An unfinished request keeps what it chose, also when its record was saved just before it was interrupted.
      const chosen = args.folder !== undefined ? canonicalPath(args.folder) : add ? add.folder ?? null : known?.record.folder ?? null;
      const project = chosen ? null : add?.project ?? await placedProject(args.project_id, service, r.token, saved, named?.projectName);
      assertStateOutsideWorkspace(home, chosen ?? project);
      if (add && (add.folder ?? null) !== chosen) throw new Error('An unfinished request for this agent names another folder. Retry it with that folder, or choose another agent name.');
      if (!add) { add = { profileId: r.personId, projectId: args.project_id, name: args.agent_name, folder: chosen, project, candidateToken: (known && known.record.folder === chosen ? known.token : null) ?? randomBytes(32).toString('base64url') }; writePrivate(path, add); }
      // A refusal is final, so its request is not kept: the next attempt starts from what is saved.
      // For an agent placed in the layout the service is told the project's folder; the agent's is inside it.
      const result = await request(`/projects/${args.project_id}/agents/connect`, { method: 'POST', token: r.token, body: { name: args.agent_name, candidateTokenHash: hash(add.candidateToken), clientName, ...(webStartId ? { webStartId } : {}), folder: chosen ?? project, ...(exact ?? known?.record.agentId ? { agentId: exact ?? known.record.agentId } : {}) } })
        .catch(error => { if (error?.refusal === true) unlinkSync(path); throw error; });
      if (!/^[\w-]{1,200}$/.test(result.agentId ?? '') || result.agentName !== args.agent_name || result.projectId !== args.project_id || ((exact ?? known?.record.agentId) && result.agentId !== (exact ?? known.record.agentId))) throw new Error('Owner service returned a different agent than requested. Nothing was saved; review My agents.');
      const folder = chosen ?? join(project, `${args.agent_name}-${result.agentId.slice(0, 6).toLowerCase()}`);
      assertStateOutsideWorkspace(home, folder);
      const id = sessionId(service, result.agentId), dir = connectionDir(home, id);
      // An agent this conversation's own process keeps connected is already saved with this credential:
      // nothing is written, and its lock is this process's own.
      const lock = join(dir, 'operation.lock'), here = known?.record.id === id && known.record.folder === folder && known.token === add.candidateToken && lstatExists(lock) && readPrivate(lock).trim() === String(process.pid);
      const record = here ? validateSession(known.record, id) : validateSession({ schema: 'mcp-connection-1', id, service, ownerProfileId: r.personId, agentId: result.agentId, agentName: result.agentName, repo: projectIdentity({ projectUrl: service, repo: result.repoUrl, folder }).repo, folder, createdAt: now(), approvedAt: now(), ...(own ? { ownFolder: true } : {}), ...(webStartId ? { webStartId } : {}) }, id);
      if (!here) await withOperationLock(dir, async () => {
        writePrivate(join(dir, 'token'), add.candidateToken); saveConnection(dir, record);
      });
      unlinkSync(path);
      return { record, repo: record.repo, created: result.created === true, settings: result.settings ?? null, project_name: typeof result.projectName === 'string' ? result.projectName : null };
    };
    return withOperationLock(directory(), async () => {
      const saved = savedAgents(), matches = saved.filter(s => s.record.service === service && s.record.agentName === args.agent_name && (!exact || s.record.agentId === exact));
      if (matches.length > 1) throw new Error('Several saved agents share this name. Select the exact agent ID before reconnecting.');
      const known = matches[0] ?? null;
      if (webStartId && known && known.record.webStartId !== webStartId) throw new Error('A web start cannot adopt an existing agent. Choose another name.');
      if (known?.record.ownerProfileId && known.record.ownerProfileId !== r.personId) throw new Error('This saved agent belongs to its original human account. No credentials were changed.');
      try { return await once(known, saved); }
      catch (error) {
        // The saved record belongs to an agent the service no longer has under this name, such as one revoked on
        // My agents. It is left alone and the name is added as a new agent, with a new credential and folder.
        if (!known || exact || !/^Owner operation refused: You have no agent with this ID and name/.test(error.message)) throw error;
        if (webStartId) throw error;
        return once(null, saved);
      }
    });
  }
  // Trusted service delivery ports, deliberately absent from the caller-selected
  // MCP operation catalog. Credentials stay in this client and never in snapshots.
  const participationRequest = (path, body, options = {}) => {
    const account = selectedAccount(options.expectedProfileId);
    return request(path, { ...(body === undefined ? {} : { method: 'POST', body }), token: account.token, profileId: account.personId, signal: options.signal });
  };
  return { origin,connect,finish,operation,addAgent,
    async submitSteering(projectId,input,options={}) {
      if(!ID.test(projectId??''))throw new Error('Use the project ID.');
      const value=await participationRequest(`/projects/${projectId}/steering`,input,options);
      try { selectedAccount(options.expectedProfileId); }catch(error){throw Object.assign(error,{refusal:true,code:'unauthorized'});}return value;
    },
    async steeringResult(projectId,operationId,options={}) {
      if(!ID.test(projectId??'')||!UUID.test(operationId??''))throw new Error('Use the original steering request.');
      const value=await participationRequest(`/projects/${projectId}/steering/${operationId}`,undefined,options);
      try { selectedAccount(options.expectedProfileId); }catch(error){throw Object.assign(error,{refusal:true,code:'unauthorized'});}return value;
    },
    currentAccount: () => publicState(approved()),
    localAgentConnections({ expectedProfileId } = {}) {
      const account = selectedAccount(expectedProfileId);
      return savedAgents().filter(({ record }) => record.ownerProfileId === account.personId && new URL(record.service).origin === origin)
        .map(({ record, token }) => ({ record: validateSession(record, record.id), token }));
    },
    publishRuntimeReadiness: (input, options) => participationRequest('/runtime/readiness', input, options),
    listAgentStarts: options => participationRequest('/agent-starts', undefined, options),
    listRepositoryAccess: options => participationRequest('/repository-access', undefined, options),
    reportMergePolicy: (input, options) => participationRequest('/repository-access/merge-policy', input, options),
    reportRepositoryAccess: (input, options) => participationRequest('/repository-access/observations', input, options),
    queueAgentRun: (input, options) => participationRequest('/agent-starts', input, options),
    inspectAgentStart(id, target, options) {
      if (!UUID.test(id ?? '') || !ID.test(target?.projectId ?? '') || !/^[\w-]{1,200}$/.test(target?.agentId ?? '')) throw new Error('Use the exact queued run and agent.');
      return participationRequest(`/agent-starts/${id}?${new URLSearchParams({projectId:target.projectId,agentId:target.agentId})}`, undefined, options);
    },
    async agentStartCancellation(operationId, target, options) {
      if (!UUID.test(operationId ?? '') || !ID.test(target?.projectId ?? '') || !/^[\w-]{1,200}$/.test(target?.agentId ?? '')) throw new Error('Use the original queued stop and target.');
      const value=await participationRequest(`/agent-start-controls/${operationId}?${new URLSearchParams({projectId:target.projectId,agentId:target.agentId})}`, undefined, options);
      if(!Object.hasOwn(value,'cancellation'))throw new Error('The website sent an unexpected cancellation reply.');
      return value.cancellation;
    },
    cancelAgentStart(id, input, options) {
      if (!UUID.test(id ?? '')) throw new Error('Use the exact queued run.');
      return participationRequest(`/agent-starts/${id}/cancel`, input, options);
    },
    acceptAgentStart(id, input, options) {
      if (!UUID.test(id ?? '')) throw new Error('Use the original web start UUID.');
      return participationRequest(`/agent-starts/${id}/accept`, input, options);
    },
    acknowledgeAgentStart(id, input, options) {
      if (!UUID.test(id ?? '')) throw new Error('Use the original web start UUID.');
      return participationRequest(`/agent-starts/${id}/receipt`, input, options);
    },
    syncBackgrounds: (input, options) => participationRequest('/backgrounds/sync', input, options),
    listBackgroundControls: options => participationRequest('/background-controls', undefined, options),
    acknowledgeBackgroundControl(id, receipt, options) {
      if (!UUID.test(id ?? '')) throw new Error('Background control requires its original UUID.');
      return participationRequest(`/background-controls/${id}/receipt`, receipt, options);
    },
    syncParticipations: (input, options) => participationRequest('/participations/sync', input, options),
    listParticipationControls: options => participationRequest('/participation-controls', undefined, options),
    acceptParticipationControl(id, options) {
      if (!UUID.test(id ?? '')) throw new Error('Participation control requires its original UUID.');
      return participationRequest(`/participation-controls/${id}/accept`, {}, options);
    },
    acknowledgeParticipationControl(id, receipt, options) {
      if (!UUID.test(id ?? '')) throw new Error('Participation control requires its original UUID.');
      return participationRequest(`/participation-controls/${id}/receipt`, receipt, options);
    },
  };
}
