import { CONTEXT_TOOL_NAMES } from '../src/turn-context.mjs';
import { attributionFromProjectContext } from '../src/github-attribution.mjs';
import { PROJECT_IMAGE_TOOL, uploadProjectImage } from '../src/project-image.mjs';
// Single-writer local intent journal, owned by the foreground runner (OPE-20).
// The MCP child accesses it through an authenticated loopback bridge, never by writing the file.
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { replaceFile } from '../src/state.mjs';
import { existsSync, readFileSync, statSync, writeFileSync, openSync, fsyncSync, closeSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
// Constant-time, as on the service's own endpoints: a local process must not learn the secret byte by byte.
export const bearerMatches = (header, secret) => {
  const given = Buffer.from(typeof header === 'string' ? header : ''), expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const JOURNAL_BYTES = 2 * 1024 * 1024;
const JOURNAL_SLOTS = 128;
const SEND_ID = /^[A-Za-z0-9_-]{1,64}$/;
const digest = text => createHash('sha256').update(text).digest('hex');
const refusalResult = text => ({ content: [{ type: 'text', text }], isError: true });
function normalizedSend(args) {
  if (!args || typeof args.client_message_id !== 'string' || !SEND_ID.test(args.client_message_id) || !Array.isArray(args.to) || args.to.length > 20 || (!args.to.length && args.thread_id === undefined)
    || args.to.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) || typeof args.body !== 'string'
    || !args.body.trim() || [...args.body].length > 2000 || (args.thread_id !== undefined && (typeof args.thread_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(args.thread_id)))
    || args.summary !== undefined && (typeof args.summary !== 'string' || !args.summary.trim() || [...args.summary].length > 180 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(args.summary))
    || Object.keys(args).some(key => !['to', 'body', 'summary', 'thread_id', 'client_message_id'].includes(key))) throw new TypeError('Invalid deferred send arguments.');
  return { to: [...new Set(args.to)].sort(), body: args.body, ...(args.summary === undefined ? {} : { summary: args.summary }), ...(args.thread_id === undefined ? {} : { thread_id: args.thread_id }), client_message_id: args.client_message_id };
}

export class DeferredSends {
  constructor(file, identity) {
    Object.assign(this, { file, identity });
    this.data = { version: 1, identity, pending: [], notices: [] };
    if (existsSync(file)) {
      if (statSync(file).size > JOURNAL_BYTES) throw new Error('Deferred send journal is too large; inspect it before restarting.');
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.version !== 1 || data.identity !== identity || !Array.isArray(data.pending) || !Array.isArray(data.notices)
        || data.pending.length + data.notices.length > JOURNAL_SLOTS) throw new Error('Deferred sends belong to another connection or have an unsupported format.');
      const ids = new Set();
      for (const entry of data.pending) {
        if (ids.has(entry.id) || normalizedSend(entry.args).client_message_id !== entry.id || entry.fingerprint !== digest(JSON.stringify(normalizedSend(entry.args)))
          || !Number.isSafeInteger(entry.nextAt) || entry.nextAt < 0 || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0 || typeof entry.deferred !== 'boolean') throw new Error('Invalid deferred send journal.');
        ids.add(entry.id); entry.deferred = true; // an unfinished pre-crash request has an ambiguous result
      }
      for (const note of data.notices) if (!SEND_ID.test(note.id) || !['delivered', 'failed'].includes(note.status)
        || !Number.isSafeInteger(note.at) || note.at < 0 || typeof note.code !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(note.code)) throw new Error('Invalid deferred send notice.');
      this.data = data;
    }
  }
  save() {
    const text = JSON.stringify(this.data);
    if (Buffer.byteLength(text) > JOURNAL_BYTES) throw new Error('Deferred send journal is full.');
    const draft = `${this.file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const fd = openSync(draft, 'wx', 0o600);
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      replaceFile(draft, this.file);
      // Windows cannot open a directory to fsync it.
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(this.file), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } finally { rmSync(draft, { force: true }); }
  }
  add(args) {
    args = normalizedSend(args);
    const fingerprint = digest(JSON.stringify(args));
    const prior = this.data.pending.find(entry => entry.id === args.client_message_id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new TypeError('This pending client message ID already has different content.');
      return { entry: prior, existing: true };
    }
    if (this.data.pending.length + this.data.notices.length >= JOURNAL_SLOTS) throw new TypeError('Deferred send journal is full; handle its pending results first.');
    const entry = { id: args.client_message_id, args, fingerprint, nextAt: Date.now(), attempts: 0, deferred: false };
    this.data.pending.push(entry); this.save();
    return { entry, existing: false };
  }
  defer(entry, seconds) {
    entry.deferred = true;
    entry.nextAt = Date.now() + Math.ceil(seconds * 1000);
    this.save();
  }
  complete(entry, status, code) {
    this.data.pending = this.data.pending.filter(item => item.id !== entry.id);
    if (entry.deferred) this.data.notices.push({ id: entry.id, status, code, at: Date.now() });
    this.save();
  }
  notices() { return this.data.notices.map(note => ({ ...note })); }
  acknowledge(notes) {
    const seen = new Set(notes.map(note => JSON.stringify(note)));
    this.data.notices = this.data.notices.filter(note => !seen.has(JSON.stringify(note)));
    this.save();
  }
}

// Fixed categories keep telemetry bounded and prevent arbitrary tool names/arguments from
// becoming stored metadata. Only numeric sizes cross the runtime reporting boundary.
const contextCategory = name => {
  if (name === 'get_project') return 'project';
  if (name === 'find_agents') return 'discovery';
  if (name === 'read_agent_inbox') return 'updates';
  if (name === 'read_thread') return 'threads';
  if (name === 'send_message') return 'messaging';
  if (['record_work_intent', 'list_work_intents'].includes(name)) return 'checkpoints';
  if (['list_tasks', 'get_task', 'create_task', 'update_task', 'claim_task', 'release_task', 'comment_task', 'link_task'].includes(name)) return 'coordination';
  if (['read_teams', 'manage_team'].includes(name)) return 'coordination';
  return 'other';
};

export class ProjectOperations {
  constructor(control, file, { folder, fetchImpl = fetch, verifyProject = () => {} } = {}) {
    this.control = control; this.onDeferred = () => {};
    this.folder = folder; this.fetchImpl = fetchImpl; this.verifyProject = verifyProject;
    this.journal = new DeferredSends(file, digest(JSON.stringify([control.url, control.token])));
    this.secret = randomBytes(32).toString('hex'); this.queue = Promise.resolve(); this.closed = false; this.fault = null;
  }
  beginContext() { this.context = { catalogRequests: 0, catalogBytes: 0, tools: new Map(), byTool: new Map() }; }
  // pauseUpdate: the one short update turn after a project Pause, which runs only while the project is paused.
  async beginParticipationTurn({ pauseUpdate = false } = {}) {
    this.participationSnapshot = null;
    const reply = await this.forward({ jsonrpc: '2.0', id: 'participation-start', method: 'tools/call',
      params: { name: 'get_project', arguments: {} } });
    if (reply?.error || reply?.result?.isError) throw new Error('Project context could not be read before this turn.');
    const text = reply?.result?.content?.find(part => part.type === 'text')?.text;
    const value = JSON.parse(text ?? '');
    this.verifyProject(value);
    if (value?.project?.started !== true || value.project.paused !== pauseUpdate || value.project.completedAt != null)
      throw new Error(pauseUpdate ? 'The project is no longer paused. No pause update was started.' : 'Project work is not currently running. No native model was started.');
    const project = value.project;
    if (!['humans', 'other_agents', 'agent_review', 'anyone'].includes(project.mergeApproval)
      || !['name', 'mission', 'rules', 'repoUrl'].every(key => typeof project[key] === 'string'))
      throw new Error('Current project rules are incomplete. Refresh the project Card before starting model work.');
    const context = value?.you?.participation;
    if (!context) throw new Error('Current project participation context is incomplete.');
    const persona = context.persona;
    if (!context.identity || !['projectId', 'agentId', 'profileId'].every(key => typeof context.identity[key] === 'string')
      || !persona || typeof persona.text !== 'string' || [...persona.text].length > 2000
      || !Number.isSafeInteger(persona.revision) || persona.revision < 0
      || !Number.isSafeInteger(context.observedAt) || context.observedAt < 0)
      throw new Error('Project participation context is incomplete.');
    // Missing display references do not stop useful work or justify guessed identities.
    let githubAttribution = null;
    try { githubAttribution = attributionFromProjectContext(value); } catch {}
    // Optional native tasks: read fresh at each turn boundary; absent means on, matching the server.
    // Counts are a hint toward list_tasks; an older server or a malformed value omits them.
    const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
    const taskCounts = value => value && count(value.assignedToYouOpen) !== null && count(value.unassignedBacklog) !== null
      ? { assignedToYouOpen: value.assignedToYouOpen, unassignedBacklog: value.unassignedBacklog } : null;
    this.participationSnapshot = { project: { name: project.name, mission: project.mission, rules: project.rules, repoUrl: project.repoUrl, mergeApproval: project.mergeApproval, cardVersion: project.cardVersion ?? null, nativeTasksEnabled: value.tasks?.enabled !== false, nativeTeamsEnabled: value.teams?.enabled === true }, persona: structuredClone(persona), capturedAt: context.observedAt, githubAttribution,
      runId: this.control.runId, identity: structuredClone(context.identity), taskCounts: taskCounts(value.tasks?.counts), updateDue: value.projectUpdates?.due === true && value.projectUpdates.yours === true, updateClosing: value.projectUpdates?.closing === true, updateJobStartedAt: Number.isFinite(value.projectUpdates?.jobStartedAt) ? value.projectUpdates.jobStartedAt : null,
      updatePostedTitles: Array.isArray(value.projectUpdates?.postedTitles) ? value.projectUpdates.postedTitles.filter(title => typeof title === 'string').slice(-5) : [],
      updateEveryMinutes: [5, 15, 30].includes(value.projectUpdates?.everyMinutes) ? value.projectUpdates.everyMinutes : 5,
      updateSlides: Number.isSafeInteger(value.projectUpdates?.maxSlides) && value.projectUpdates.maxSlides > 1,
      previewUrl: typeof project.previewUrl === 'string' && project.previewUrl ? project.previewUrl.slice(0, 500) : null,
      updateLastPublishedAt: Number.isFinite(value.projectUpdates?.lastPublishedAt) ? value.projectUpdates.lastPublishedAt : null };
    return structuredClone(this.participationSnapshot);
  }
  async projectForTurn(rpc) {
    const snapshot = this.participationSnapshot;
    const reply = await this.forward(rpc); // always recheck remote access/state
    if (!snapshot || reply?.error || reply?.result?.isError) return reply;
    if (snapshot.runId !== this.control.runId) throw new Error('The persona snapshot belongs to a different run.');
    const part = reply?.result?.content?.find(item => item.type === 'text');
    if (!part) return reply;
    const value = JSON.parse(part.text);
    if (value?.you?.participation) {
      if (!['projectId', 'agentId', 'profileId'].every(key => value.you.participation.identity?.[key] === snapshot.identity[key]))
        throw new Error('The persona snapshot belongs to a different participant.');
      value.you.participation.persona = structuredClone(snapshot.persona);
      value.you.participation.personaCapturedAt = snapshot.capturedAt;
    }
    // The turn prompt already carries the goal in the project Card.
    if (value?.project && typeof value.project === 'object') delete value.project.mission;
    part.text = JSON.stringify(value);
    return reply;
  }
  endContext() {
    const context = this.context; this.context = null;
    return { catalogRequests: context?.catalogRequests ?? 0, catalogBytes: context?.catalogBytes ?? 0,
      tools: [...(context?.tools.values() ?? [])].map(item => ({ ...item })),
      byTool: [...(context?.byTool.values() ?? [])].map(item=>({...item})) };
  }
  recordContext(context, rpc, reply) {
    if (!context || context !== this.context) return; // completed outside this model boundary
    if (rpc.method === 'tools/list' && Array.isArray(reply?.result?.tools)) {
      context.catalogRequests++; context.catalogBytes += Buffer.byteLength(JSON.stringify(reply.result.tools));
      for(const tool of reply.result.tools) if(CONTEXT_TOOL_NAMES.includes(tool.name)) {
        const item=context.byTool.get(tool.name)??{name:tool.name,catalogDeliveries:0,definitionBytes:0,calls:0,argumentBytes:0,responseTextBytes:0,refusals:0};
        item.catalogDeliveries++;item.definitionBytes+=Buffer.byteLength(JSON.stringify(tool),'utf8');context.byTool.set(tool.name,item);
      }
    }
    if (rpc.method !== 'tools/call') return;
    const category = contextCategory(rpc.params?.name);
    const item = context.tools.get(category) ?? { category, calls: 0, argumentBytes: 0, responseTextBytes: 0, refusals: 0 };
    item.calls++; item.argumentBytes += Buffer.byteLength(JSON.stringify(rpc.params?.arguments ?? {}));
    const content = reply?.result?.content;
    if (Array.isArray(content)) item.responseTextBytes += content.reduce((n, part) => n + (part.type === 'text' && typeof part.text === 'string' ? Buffer.byteLength(part.text) : 0), 0);
    if (reply?.result?.isError || reply?.error) item.refusals++;
    context.tools.set(category, item);
    const name=rpc.params?.name;
    if(CONTEXT_TOOL_NAMES.includes(name)) {
      const tool=context.byTool.get(name)??{name,catalogDeliveries:0,definitionBytes:0,calls:0,argumentBytes:0,responseTextBytes:0,refusals:0};
      tool.calls++;tool.argumentBytes+=Buffer.byteLength(JSON.stringify(rpc.params?.arguments??{}),'utf8');
      if(Array.isArray(content))tool.responseTextBytes+=content.reduce((n,part)=>n+(part.type==='text'&&typeof part.text==='string'?Buffer.byteLength(part.text,'utf8'):0),0);
      if(reply?.result?.isError||reply?.error)tool.refusals++;
      context.byTool.set(name,tool);
    }
  }
  serialize(action) { const task = this.queue.then(() => { if (this.fault) throw this.fault; return action(); }); this.queue = task.catch(error => { if (!this.closed) { this.fault = error; this.onDeferred(); } }); return task; }
  // Discussion remains available while paused. Let the service reject a closed-project
  // send (or recover its original receipt) instead of retaining it for a future reopen.
  canSend() { return !this.closed && !this.control.closed && !this.control.fatal && this.control.news?.project?.started; }
  pendingResult(entry) { return { content: [{ type: 'text', text: JSON.stringify({ status: 'pending', client_message_id: entry.id, retry_at: entry.nextAt, instruction: 'The runner saved this send and will retry without model usage. Finish this turn; do not send a replacement message.' }) }] }; }
  async forward(rpc, { folder = this.folder } = {}) {
    if (rpc.method === 'tools/call' && rpc.params?.name === PROJECT_IMAGE_TOOL.name) {
      try {
        const receipt = await uploadProjectImage(this.control, rpc.params.arguments, folder, { fetchImpl: this.fetchImpl });
        return { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(receipt) }], ...(receipt.error ? { isError: true } : {}) } };
      } catch (error) {
        return { jsonrpc: '2.0', id: rpc.id, result: refusalResult(error.message) };
      }
    }
    const response = await this.fetchImpl(`${this.control.url}/v2/mcp`, {
      method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${this.control.token}`, 'x-pilot-run': this.control.runId,
        'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(rpc), signal: AbortSignal.any([AbortSignal.timeout(15_000), this.control.requestSignal, this.control.abort?.signal].filter(Boolean)),
    });
    let text = '', bytes = 0; const decoder = new TextDecoder();
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > JOURNAL_BYTES) throw new Error('MCP response exceeds the local bridge bound.');
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    if (!text && response.ok && rpc.id === undefined) return null;
    const data = JSON.parse(text.split('\n').find(line => line.startsWith('data:'))?.slice(5) ?? text);
    if (!response.ok || typeof data.error === 'string') {
      if (rpc.method === 'tools/call') return { jsonrpc: '2.0', id: rpc.id, result: refusalResult(`${data.error ?? 'internal_error'}: ${data.message ?? 'Remote call refused.'} (retry_after_seconds: ${data.retry_after_seconds ?? 20})`) };
      throw new Error('Remote MCP request refused.');
    }
    if (rpc.method === 'tools/list' && Array.isArray(data.result?.tools))
      data.result.tools.push(PROJECT_IMAGE_TOOL);
    return data;
  }
  async attempt(entry, rpc, observed = () => true) {
    if (!this.canSend()) {
      this.journal.defer(entry, this.control.pollSeconds ?? 20); this.onDeferred();
      return this.pendingResult(entry);
    }
    entry.attempts = Math.min(Number.MAX_SAFE_INTEGER, entry.attempts + 1); this.journal.save(); // preserve identity before an ambiguous network boundary
    let reply;
    try { reply = await this.forward(rpc); } catch {
      this.journal.defer(entry, Math.min(3600, 20 * 2 ** Math.min(entry.attempts - 1, 7))); this.onDeferred();
      return this.pendingResult(entry);
    }
    if (!observed()) entry.deferred = true; // the model disconnected before receiving the result
    const result = reply?.result;
    const text = result?.content?.find(item => item.type === 'text')?.text ?? '';
    const code = text.split(':')[0];
    if (result?.isError && ['rate_limited', 'project_busy', 'recipient_backlog', 'internal_error', 'paused', 'not_started'].includes(code)) {
      const seconds = Number(/retry_after_seconds:\s*(\d+(?:\.\d+)?)/.exec(text)?.[1] ?? 20);
      this.journal.defer(entry, Math.max(1, Math.min(86400, seconds))); this.onDeferred();
      return this.pendingResult(entry);
    }
    if (result?.isError) { this.journal.complete(entry, 'failed', /^[A-Za-z0-9_-]{1,100}$/.test(code) ? code : 'refused'); return result; }
    let value;
    try { value = JSON.parse(text); } catch { /* ambiguous protocol success is retried using the same id */ }
    if (!value?.message || typeof value.message.id !== 'string') {
      this.journal.defer(entry, 20); this.onDeferred(); return this.pendingResult(entry);
    }
    this.journal.complete(entry, 'delivered', 'accepted');
    return result;
  }
  async call(rpc, observed = () => true, { folder = this.folder } = {}) {
    if (rpc.method === 'tools/call' && rpc.params?.name === 'get_project') return this.projectForTurn(rpc);
    if (rpc.method !== 'tools/call' || rpc.params?.name !== 'send_message') return this.forward(rpc, { folder });
    return this.serialize(async () => {
      if (this.closed) throw new Error('Local MCP bridge stopped.');
      let added;
      try { added = this.journal.add(rpc.params.arguments); } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return { jsonrpc: '2.0', id: rpc.id, result: refusalResult(`bad_input: ${error.message}`) };
      }
      const result = added.existing ? (this.onDeferred(), this.pendingResult(added.entry)) : await this.attempt(added.entry, { ...rpc, params: { ...rpc.params, arguments: added.entry.args } }, observed);
      return { jsonrpc: '2.0', id: rpc.id, result };
    });
  }
  retryDue() {
    if (this.retryPending) return this.retryPending;
    // Coalesce timer ticks while queued or sending. One network attempt per pass
    // leaves room for fresh sends and shutdown; oldest due entries go first.
    this.retryPending = this.serialize(async () => {
      if (!this.canSend()) return;
      const entry = this.journal.data.pending.filter(item => item.nextAt <= Date.now())
        .reduce((oldest, item) => !oldest || item.nextAt < oldest.nextAt ? item : oldest, null);
      if (entry) await this.attempt(entry, { jsonrpc: '2.0', id: `retry-${entry.id}`, method: 'tools/call', params: { name: 'send_message', arguments: entry.args } });
    }).finally(() => { this.retryPending = null; });
    return this.retryPending;
  }
  async listen({ folder = this.folder } = {}) {
    if (this.closed) throw new Error('Local MCP bridge stopped.');
    this.workerUploadFolder = folder;
    this.listening ??= this.openListener().catch(error => { this.listening = null; throw error; });
    return this.listening;
  }
  async openListener() {
    this.server = createServer(async (req, res) => {
      if (this.closed || req.url !== '/mcp' || !bearerMatches(req.headers.authorization, this.secret)) { res.writeHead(401); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
      try {
        let text = '', bytes = 0; req.setEncoding('utf8');
        for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > 128 * 1024) { res.writeHead(413); res.end(); return; } text += chunk.toString('utf8'); }
        const rpc = JSON.parse(text);
        if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') throw new Error('Invalid MCP request.');
        const context = this.context;
        const reply = await this.call(rpc, () => !res.destroyed, { folder: this.workerUploadFolder });
        if (!res.destroyed) this.recordContext(context, rpc, reply);
        if (reply === null || rpc.id === undefined) { res.writeHead(204); res.end(); }
        else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)); }
      } catch { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Local MCP bridge could not complete the request.' } })); }
    });
    this.server.requestTimeout = 30_000; this.server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return { type: 'http', url: `http://127.0.0.1:${this.server.address().port}/mcp`, headers: { Authorization: `Bearer ${this.secret}` } };
  }
  async close() {
    this.closed = true;
    if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
    await this.queue;
  }
}
