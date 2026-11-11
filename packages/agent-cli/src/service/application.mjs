// One transport-independent capability boundary. Authenticated caller identity is
// supplied by service composition; tool arguments never select local authority.
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { OWNER_TOOLS } from '../owner-tools.mjs';
import { DISCOVERY_TOOLS } from '../discovery.mjs';
import { RuntimeError, validateTarget, validateUuid } from './contracts.mjs';
import { createRuntimeTools } from './runtime-tools.mjs';
import { GUIDE_REVISION } from '../version.mjs';
import { participationCommandSchema, participationQuerySchema } from './participation-contracts.mjs';
import { publicTargetSchema, bindPublicTarget } from './public-target.mjs';
import { GUIDE_SECTIONS, readBundledGuide } from '../skill-bundle.mjs';

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const bootstrap = [
  { name: 'get_mlswarm_guide', description: 'Read the MyLittleSwarm skill router and shared rules by default. Then request only the section needed: projects, agents, work-in-chat, project-work, updates-and-help or computer.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { section: { type: 'string', enum: GUIDE_SECTIONS } }, additionalProperties: false } },
];
const publicParticipationCommand = z.discriminatedUnion('kind', participationCommandSchema.options.map(schema =>
  schema.omit({ version: true }).extend({ target: publicTargetSchema })));
const publicParticipationQuery = participationQuerySchema.extend({ target: publicTargetSchema });
const passive = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

export function createRuntimeApplication({ controllers, principal, ownerClient, discovery, guide, workerOperations, participation, evidence, steering, connectionStatus }) {
  const identity = validateTarget({ ...principal, projectId: 'identity', agentId: 'identity' });
  const runtime = createRuntimeTools({ controllers, principal, evidence, steering, ownerClient, connectionStatus });
  const runtimeNames = new Set(runtime.listTools().map(tool => tool.name));
  const participationTools = participation ? [
    { name: 'work_in_this_chat', description: 'Work with the person in this chat on a project, for an agreed time: claim starts it, extend adds time, release ends it (End), and wake brings back an ended one with a new ID. Retry a lost reply with the same input. When time runs out you stop working on MyLittleSwarm; the chat itself carries on.', inputSchema: z.toJSONSchema(publicParticipationCommand) },
    { name: 'get_chat_work', description: 'Read one of your in-chat work windows: what it covers and its time left.', annotations: passive, inputSchema: z.toJSONSchema(publicParticipationQuery) },
    { name: 'list_chat_work', description: 'List the in-chat work windows of the person\'s agents, across projects or in one.', annotations: passive, inputSchema: z.toJSONSchema(z.object({ projectId: z.string().min(1).max(256).optional(), limit: z.number().int().min(1).max(100).optional(), after: z.uuid().optional() }).strict()) },
    { name: 'get_chat_work_result', description: 'Look up the result of a claim, extend, release or wake after a lost reply.', annotations: passive, inputSchema: z.toJSONSchema(z.object({ target: publicTargetSchema, operationId: z.uuid() }).strict()) },
    { name: 'get_task_tools', description: 'Discover native task operations for one approved in-chat participation. Returns that project’s current tool schemas. When tasks are off only retained-record read operations are returned; no global project selection is assumed.', annotations: passive,
      inputSchema: z.toJSONSchema(z.object({ participation_ref: z.uuid() }).strict()) },
    { name: 'call_task_tool', description: 'Invoke a task operation returned by get_task_tools for the same participation_ref. Current project capability, membership, revision and mission boundaries are checked again. It never launches, steers or extends an agent.',
      inputSchema: z.toJSONSchema(z.object({ participation_ref: z.uuid(), name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()) }).strict()) },
    { name: 'get_team_tools', description: 'Discover native team tools for one approved in-chat participation. Teams are off by default; only retained-record reads are returned while off.', annotations: passive,
      inputSchema: z.toJSONSchema(z.object({ participation_ref: z.uuid() }).strict()) },
    { name: 'call_team_tool', description: 'Invoke a team tool discovered for this participation_ref. Current project capability and agent authority are checked again. Never changes tasks or agent execution.',
      inputSchema: z.toJSONSchema(z.object({ participation_ref: z.uuid(), name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()) }).strict()) },
    ...participation.listTools(),
  ] : [];
  const ownerCatalog = [...runtime.listTools(), ...OWNER_TOOLS, ...DISCOVERY_TOOLS, ...bootstrap, ...participationTools];
  const schemas = new Map();
  const validateCaller = caller => {
    if (caller?.kind === 'owner') {
      if (caller.site !== identity.site || caller.ownerId !== identity.ownerId) throw new RuntimeError('forbidden', 'This caller is outside the installation owner.');
      return 'owner';
    }
    if (caller?.kind === 'worker') {
      const target = validateTarget(caller.target);
      validateUuid(caller.missionId, 'missionId');
      if (!Number.isSafeInteger(caller.generation) || caller.generation < 1 || target.site !== identity.site || target.ownerId !== identity.ownerId) throw new RuntimeError('forbidden', 'This worker is outside the installation owner.');
      return 'worker';
    }
    throw new RuntimeError('forbidden', 'An authenticated runtime caller is required.');
  };
  function validateArgs(kind, tool, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RuntimeError('bad_input', 'Tool arguments must be an object.');
    const key = `${kind}:${tool.name}`;
    let schema = schemas.get(key);
    if (!schema) { schema = z.fromJSONSchema(tool.inputSchema); schemas.set(key, schema); }
    const parsed = schema.safeParse(args);
    if (parsed.success) return parsed.data;
    const field = parsed.error.issues[0]?.path.join('.');
    throw new RuntimeError('bad_input', field ? `Check ${field}: it is missing or not in the expected form.` : 'Use only the fields this tool takes.');
  }
  const requirePort = port => { if (!port) throw new RuntimeError('unavailable', 'This runtime capability is not configured.'); return port; };
  function checkAccount(account) {
    if (account?.status === 'approved' && account.account_profile_id !== identity.ownerId) throw new RuntimeError('forbidden', 'Browser approval selected a different human profile. No runtime authority was changed.');
    return account;
  }
  return {
    listTools(caller, options) {
      return validateCaller(caller) === 'owner' ? structuredClone(ownerCatalog) : workerOperations?.listTools(caller, options) ?? [];
    },
    async callTool(caller, name, args = {}, { signal } = {}) {
      try {
        signal?.throwIfAborted();
        const kind = validateCaller(caller);
        // Worker operations own strict schema validation and remote request guards.
        if (kind === 'worker') {
          if (!workerOperations) throw new RuntimeError('unknown_tool', 'This operation is not available to this caller.');
          return await workerOperations.callTool(caller, name, args, { signal });
        }
        const tool = ownerCatalog.find(item => item.name === name);
        if (!tool) throw new RuntimeError('unknown_tool', 'This operation is not available to this caller.');
        const input = validateArgs(kind, tool, args);
        if (participationTools.some(item => item.name === name)) {
          if (name === 'work_in_this_chat') return result(await participation.command({ ...input, version: 1, target: bindPublicTarget(identity, input.target) }));
          if (name === 'get_chat_work') return result(await participation.get({ ...input, target: bindPublicTarget(identity, input.target) }));
          if (name === 'list_chat_work') return result(await participation.list({ ...input, site: identity.site, ownerId: identity.ownerId }));
          if (name === 'get_chat_work_result') return result(await participation.getOperation({ ...input, target: bindPublicTarget(identity, input.target) }));
          if (name === 'get_team_tools') return await participation.listTeamTools(input, { signal });
          if (name === 'call_team_tool') return await participation.callTeamTool(input, { signal });
          if (name === 'get_task_tools') return await participation.listTaskTools(input, { signal });
          if (name === 'call_task_tool') return await participation.callTaskTool(input, { signal });
          return await participation.callTool(name, input, { signal });
        }
        if (runtimeNames.has(name)) return result(await runtime.callTool(name, input, { signal }));
        if (name === 'get_mlswarm_guide') return { content: [{ type: 'text', text: input.section === undefined && guide !== undefined ? guide : readBundledGuide(input.section) }] };
        if (DISCOVERY_TOOLS.some(item => item.name === name)) return result(await requirePort(discovery).call(name, input));
        const client = requirePort(ownerClient);
        if (name === 'approve_this_computer') {
          if (input.website_origin !== undefined && input.website_origin !== identity.site) throw new RuntimeError('forbidden', 'The requested website differs from this runtime’s configured site.');
          return result({...checkAccount(await client.connect('MyLittleSwarm shared runtime', identity.site)), guide_revision:GUIDE_REVISION});
        }
        if (name === 'check_computer_approval') {
          const deadline = Date.now() + (input.wait_seconds ?? 0) * 1000;
          for (;;) {
            const account = checkAccount(await client.finish());
            if (account.status !== 'pending' || Date.now() >= deadline) return result(account);
            await new Promise((resolve, reject) => {
              const timer = setTimeout(done, Math.min(1000, deadline - Date.now()));
              function done() { signal?.removeEventListener('abort', cancelled); resolve(); }
              function cancelled() { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); reject(new RuntimeError('cancelled', 'Approval observation was cancelled.')); }
              signal?.addEventListener('abort', cancelled, { once: true });
              if (signal?.aborted) cancelled();
            });
          }
        }
        if (name === 'add_project_agent') {
          const { start = true, provider = 'claude', model = null, task, ...add } = input;
          const added = await client.addAgent(add, 'MyLittleSwarm shared runtime', { expectedProfileId: identity.ownerId });
          const record = added.record, projectId = add.project_id ?? record.service.split('/p/')[1];
          // Adding means the agent will work: its first run waits for the project to start and for this computer.
          let run = null;
          if (start) {
            const uuidFrom = text => { const h = createHash('sha256').update(text).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-${'89ab'[parseInt(h[16],16) & 3]}${h.slice(17,20)}-${h.slice(20,32)}`; };
            try {
              // A failed launch or expired request can advance; an explicit cancellation is terminal. Each ID derives
              // from the one before, so a retry after a lost reply finds the same request.
              let id = uuidFrom(`first-run:${projectId}:${record.agentId}`), queued;
              for (let attempt = 0; attempt < 10; attempt++) {
                queued = await client.queueAgentRun({ id, projectId, agentId: record.agentId, name: record.agentName, execution: { provider, model }, ...(task ? { scope: task } : {}), approved: true }, { expectedProfileId: identity.ownerId });
                if (queued?.request?.code === 'cancelled' || !['failed', 'expired'].includes(queued?.request?.state)) break;
                id = uuidFrom(`next-run:${id}`);
              }
              const savedRun = queued.request;
              run = { id: savedRun.id, state: savedRun.state, code:savedRun.code??null, provider: savedRun.execution.provider, model: savedRun.execution.model, task: savedRun.scope, starts: savedRun.code==='cancelled'?'cancelled; this request will not start. A new run needs a separate approved start.':'when the project has started and has time left, and the computer and repository are ready; the service runs it independently of this chat' };
            } catch (error) { run = { queued: false, reason: error?.message ?? 'The first run could not be queued.' }; }
          }
          return result({ project_id: projectId, agent_id: record.agentId, agent_name: record.agentName, folder: record.folder, repository: added.repo, created: added.created, project_name: added.project_name, saved_defaults: added.settings, run });
        }
        return result(await client.operation(name, input, { expectedProfileId: identity.ownerId, signal }));
      } catch (error) {
        // A permanent refusal from the website is known and safe to show; other failures stay unconfirmed.
        const safe = error instanceof RuntimeError ? { code: error.code, message: error.message }
          : error?.refusal ? { code: error.code, message: error.message, ...(error.limit ? { limit: error.limit, retryable: false } : {}) } : { code: signal?.aborted ? 'cancelled' : 'operation_failed', message: 'MyLittleSwarm couldn’t confirm whether that happened. Check before trying again, and reuse the same request ID if you do.' };
        return { ...result({ error: safe }), isError: true };
      }
    },
  };
}
