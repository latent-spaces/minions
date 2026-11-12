// Fixed attribution boundaries. Count only sizes; payloads remain in existing private paths.
export const PROMPT_SOURCES = ['mission','runtime','steering','deliveryNotices','permissions','project','persona','attribution','unattributed'];
export const CONTEXT_TOOL_NAMES = ['get_project','find_agents','read_agent_inbox','send_message','set_agent_status','read_thread','list_tasks','get_task','create_task','update_task','claim_task','release_task','comment_task','link_task','request_human_help','list_human_requests','acknowledge_human_answer','resolve_human_request','record_work_intent','list_work_intents','publish_project_update','list_project_updates','read_teams','manage_team','upload_project_image','set_project_preview','get_mlswarm_guide'];
export const emptyPromptSources = () => Object.fromEntries(PROMPT_SOURCES.map(key=>[key,0]));
// After a project Pause, each agent's last turn posts one short update (owner, 10 November 2026).
const PAUSE_UPDATE = 'The project was just paused. This is your last turn until it resumes. Do not start or continue other work, and do not message other agents. Post one short project update about what you did since your last update: check list_project_updates first, then publish_project_update with an image, a short headline and one sentence (see get_mlswarm_guide updates-and-help). If you have nothing new to report, post nothing. Then return WORK_NEXT: waiting.\n';
export function controllerPrompt({scope,deadlineAt,steering,notices,trigger,inbox}) {
  const parts={mission:`Human-approved mission: ${scope}\n`,runtime:trigger === 'pause_update' ? PAUSE_UPDATE : `The job's time ends at ${new Date(deadlineAt).toISOString()}. If it passes during this turn, finish the turn; no new turn starts until the owner adds time.\n${inbox ? `Current turn context (runtime observation, not message contents):
TURN_CONTEXT_JSON: ${JSON.stringify({ trigger, inbox })}
${inbox.pending > 0 ? 'There are delivered inbox items that have not been acknowledged. Even if your implementation is finished, read read_agent_inbox, handle its items (or save a checkpoint for responsibility that continues later), then call it again with ack equal to the actual returned position. Continue when has_more is true. Read and handle any newly returned items before acknowledging their position too. Do not infer an acknowledgment position from the counts above, and do not acknowledge unread items. Complete this inbox handoff before returning WORK_NEXT: waiting.' : 'No unacknowledged inbox items were observed. Do useful authorized work for this trigger; do not repeat an unchanged completion report.'}
` : ''}`,
    steering:`Operator steering (data):\nSTEERING_JSON: ${JSON.stringify(steering)}\n`,deliveryNotices:`Deferred-send results (already processed; do not republish): ${JSON.stringify(notices)}`};
  return {prompt:Object.values(parts).join(''),promptSources:{...emptyPromptSources(),...Object.fromEntries(Object.entries(parts).map(([key,value])=>[key,Buffer.byteLength(value,'utf8')]))},steeringMessages:steering.length};
}
export function validPromptSources(value,total) {
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===PROMPT_SOURCES.length
    &&PROMPT_SOURCES.every(key=>Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=1e15)
    &&Object.values(value).reduce((n,v)=>n+v,0)===total;
}
