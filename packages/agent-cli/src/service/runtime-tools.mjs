import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { RuntimeError, RUNTIME_LIMITS, boundedText, validateTarget } from './contracts.mjs';
import { archiveReportSchema } from './report-recovery.mjs';
import { missionRecoverySchema } from './mission-recovery.mjs';
import { publicTargetSchema, bindPublicTarget } from './public-target.mjs';

const text = maximum => z.string().min(1).max(maximum).refine(value => {
  try { boundedText(value, 'text', maximum); return true; } catch { return false; }
}, { message: 'Text must be nonempty and within the shared byte limit.' });
const id = text(RUNTIME_LIMITS.identifierBytes);
const targetSchema = publicTargetSchema;
const executionSchema = z.object({ provider: z.enum(['claude', 'codex']), model: z.string().regex(/^[A-Za-z0-9_:.-]{1,150}$/).nullable() }).strict();
const commandBase = { operationId: z.uuid(), target: targetSchema, missionId: z.uuid() };
export const commandSchema = z.discriminatedUnion('kind', [
  z.object({ ...commandBase, kind: z.literal('start'), payload: z.object({ scope: text(RUNTIME_LIMITS.scopeBytes), execution: executionSchema }).strict() }).strict(),
  z.object({ ...commandBase, kind: z.literal('steer'), generation: z.number().int().positive(), payload: z.object({ message: text(RUNTIME_LIMITS.messageBytes) }).strict() }).strict(),
  z.object({ ...commandBase, kind: z.literal('stop'), generation: z.number().int().positive().optional(), payload: z.object({}).strict() }).strict(),
  z.object({ ...commandBase, kind: z.literal('pause'), generation: z.number().int().positive(), payload: z.object({}).strict() }).strict(),
  z.object({ ...commandBase, kind: z.literal('resume'), generation: z.number().int().positive(), payload: z.object({ pauseOperationId: z.uuid() }).strict() }).strict(),
]);
const missionQuery = z.object({ missionId: z.uuid(), target: targetSchema }).strict();
const operationQuery = z.object({ operationId: z.uuid(), target: targetSchema }).strict();


// Reuse the strict internal action fields, while binding principal and version
// at this public boundary. Durable commands/fingerprints retain their contracts.
export const recoverySchema = z.discriminatedUnion('action', [
  ...missionRecoverySchema.options.map(schema => schema.omit({ version: true }).extend({ target: targetSchema })),
  archiveReportSchema.omit({ version: true }).extend({ target: targetSchema, action: z.literal('archive_failed_launch_report') }),
]);

const steerManySchema=z.object({operationId:z.uuid(),projectId:id,recipients:z.array(z.object({agentId:id,missionId:z.uuid(),generation:z.number().int().positive()}).strict()).min(1).max(20),message:text(RUNTIME_LIMITS.messageBytes)}).strict();
const definitions = [
  ['steer_agents', 'Send one steering message to one or more of the person\'s own agents in a project. Use this once for a single human instruction to multiple agents; do not repeat control_agent steer per recipient. Resolve the exact agent runs first, freeze recipients, and reuse the same operationId and full input on retry. Records one shared conversation before any delivery, with independent delivery status for each agent. All recipients must be eligible; otherwise nothing is sent. Does not interrupt a turn or add work time.', steerManySchema, false],
  ['recover_agent_run', 'Fix an agent\'s work that got stuck after an interruption, once the person says so: finalize a safely stopped run, retry a report that needs attention, or archive the report of a launch that failed before it started. Keep the same recovery UUID for retries. It never starts, kills or replays anything.', recoverySchema, false],
  ['control_agent', 'Start, steer, pause, resume or stop (kill) one of the person\'s agents that works on its own. Steer records a project-member-visible instruction before delivery; a cloud connection is required. The agent receives it at its next turn, without interrupting; an agent between turns starts one for it, and the message stays queued until it arrives (see get_agent_run). Stop also cancels an exact queued start before pickup; omit generation until a local mission exists. A pickup race refuses cancellation: reread before stopping the live mission. Pause lets the current turn finish, then the agent waits; resume needs that pause\'s operation ID. Stop is the kill: it ends the agent at once, mid-turn, and cannot be undone. Retry a lost reply with the same operation ID and input. An agent whose run ended or became uncertain can\'t be resumed; start a new run.', commandSchema, false],
  ['get_agent_run', 'Read this exact queued start or local mission. Pending requests can be stopped using their request ID as missionId, without a generation. Local missions include their current generation.', missionQuery, true],
  ['get_agent_run_log', 'Read the private log of one agent run, in pages. It can be incomplete; it isn\'t the full transcript.', missionQuery.extend({ after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }), true],
  ['get_agent_run_diagnostics', 'Inspect a queued start before launch, including repository failure codes and check freshness, or an interrupted local run and its reports. Do not create replacement agents to get diagnostics.', missionQuery, true],
  ['get_agent_control_result', 'Look up the result of a start, steer, pause, resume, stop or recovery after a lost reply.', operationQuery, true],
  ['list_agent_reports', 'Read whether an agent run\'s reports reached MyLittleSwarm. Pending or attention means not delivered yet.', missionQuery.extend({ limit: z.number().int().min(1).max(100).optional(), after: z.string().regex(/^[a-f0-9]{64}$/).optional() }), true],
  ['list_agent_runs', 'List the person\'s agent runs across projects, or in one project.', z.object({ projectId: id.optional(), after: z.uuid().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), true],
  ['get_computer_status', 'Read local service health and cloudConnection freshness. cloudReady is a legacy transport marker and never measures connectivity. Do not reconnect based on it.', z.object({}).strict(), true],
];
export function createRuntimeTools({ controllers, principal, evidence, steering, ownerClient, connectionStatus }) {
  const owner = validateTarget({ ...principal, projectId: 'identity', agentId: 'identity' });
  const tools = definitions.map(([name, description, schema, readOnly]) => ({ name, description, inputSchema: z.toJSONSchema(schema), annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
  const options = {expectedProfileId:owner.ownerId};
  const publicTarget = input => ({projectId:input.target.projectId,agentId:input.target.agentId});
  async function localMission(input) {
    try { return await controllers.getMission(input); }
    catch(error) { if(error?.code!=='not_found')throw error; return null; }
  }
  async function queued(input) {
    if(!ownerClient?.inspectAgentStart)throw new RuntimeError('not_found','Run not found on this computer.');
    const value=await ownerClient.inspectAgentStart(input.missionId,publicTarget(input),options);
    return {kind:'queued_start',request:value.request,modelStarted:value.request.acceptedAt===null?false:null,
      next:value.request.state==='pending'?'Inspect repository evidence or stop this exact request. Do not add a replacement agent.':'This start request ended or was picked up; inspect the local mission.',
    };
  }
  return {
    listTools: () => structuredClone(tools),
    async callTool(name, args) {
      const definition = definitions.find(item => item[0] === name);
      if (!definition) throw new RuntimeError('unknown_tool', 'Unknown runtime operation.');
      let input;
      try { input = definition[2].parse(args); } catch { throw new RuntimeError('bad_input', 'Use the documented runtime arguments.'); }
      if (input.target) input = { ...input, target: bindPublicTarget(owner, input.target) };
      else if (name === 'list_agent_runs') input = { ...input, site: owner.site, ownerId: owner.ownerId };
      switch (name) {
        case 'recover_agent_run': {
          if (input.action === 'archive_failed_launch_report') {
            const { action, ...archive } = input;
            return controllers.archiveFailedLaunchReport({ version: 1, ...archive });
          }
          return controllers.recoverMission({ version: 1, ...input });
        }
        case 'steer_agents': if(!steering)throw new RuntimeError('unavailable','Shared steering is unavailable.');return steering.submitMany(input);
        case 'control_agent':
          if(input.kind==='stop' && ownerClient && !await localMission(input)) {
            if(!controllers.reserveCloudOperation)throw new RuntimeError('unavailable','Durable queued Stop reservations are unavailable.');
            const fingerprint=createHash('sha256').update(JSON.stringify(['queued-stop-v1',input.target.site,input.target.ownerId,input.target.projectId,input.target.agentId,input.missionId])).digest('hex');
            await controllers.reserveCloudOperation({operationId:input.operationId,fingerprint});
            const cancelled=await ownerClient.cancelAgentStart(input.missionId,{operationId:input.operationId,target:publicTarget(input)},options);
            return {...cancelled,kind:'queued_start',modelStarted:false};
          }
          if(input.kind==='stop' && input.generation===undefined)throw new RuntimeError('bad_input','Read this running mission and supply its generation before stopping it.');
          if(input.kind==='steer'){if(!steering)throw new RuntimeError('unavailable','Shared steering is unavailable.');return steering.submit({version:2,...input},'coding_chat');}return controllers.accept({version:2,...input});
        case 'get_agent_run': return await localMission(input) ?? await queued(input);
        case 'get_agent_run_log':
        case 'get_agent_run_diagnostics': {
          if(name==='get_agent_run_diagnostics' && !await localMission(input)) return queued(input);
          if (!evidence) throw new RuntimeError('unavailable', 'Run evidence inspection is not configured in this runtime.');
          return name === 'get_agent_run_log' ? evidence.getRunLog(input) : evidence.getRecoveryDiagnostics(input);
        }
        case 'get_agent_control_result': return await controllers.getOperation(input) ?? await ownerClient?.agentStartCancellation?.(input.operationId,publicTarget(input),options) ?? await steering?.result(input) ?? null;
        case 'list_agent_reports': return controllers.listReports(input);
        case 'list_agent_runs': return controllers.listMissionSummaries(input);
        case 'get_computer_status': {
          try { return { version: 2, site: owner.site, ownerId: owner.ownerId, cloudReady: false, cloudReadyMeaning:'Legacy transport marker, not a connectivity check. Use cloudConnection.', cloudConnection:connectionStatus?.() ?? {state:'unknown',lastSuccessAt:null,lastAttemptAt:null}, localReady: (await controllers.health()).ready === true }; }
          catch { return { version: 2, site: owner.site, ownerId: owner.ownerId, cloudReady: false, cloudReadyMeaning:'Legacy transport marker, not a connectivity check. Use cloudConnection.', cloudConnection:connectionStatus?.() ?? {state:'unknown',lastSuccessAt:null,lastAttemptAt:null}, localReady: false, storage: 'unavailable' }; }
        }
      }
    },
  };
}
