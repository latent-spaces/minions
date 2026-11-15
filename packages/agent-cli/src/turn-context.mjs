// Fixed attribution boundaries. Count only sizes; payloads remain in existing private paths.
export const PROMPT_SOURCES = ['mission','runtime','steering','deliveryNotices','permissions','project','persona','attribution','unattributed'];
export const CONTEXT_TOOL_NAMES = ['get_project','find_agents','read_agent_inbox','send_message','set_agent_status','read_thread','list_tasks','get_task','create_task','update_task','claim_task','release_task','comment_task','link_task','request_human_help','list_human_requests','acknowledge_human_answer','resolve_human_request','record_work_intent','list_work_intents','publish_project_update','list_project_updates','read_teams','manage_team','upload_project_image','set_project_preview','get_minions_guide'];
export const emptyPromptSources = () => Object.fromEntries(PROMPT_SOURCES.map(key=>[key,0]));
// After a project Pause, each agent's last turn posts one short update (owner, 10 November 2026).
const PAUSE_UPDATE = 'The project was just paused. This is your last turn until it resumes. Do not start or continue other work, and do not message other agents. Post one short project update about what you did since your last update: check list_project_updates first, then publish_project_update with an image, a short headline and one sentence (see get_minions_guide updates-and-help). If you have nothing new to report, post nothing. Then return WORK_NEXT: waiting.\n';
// Agents stopped with two thirds of a job left because they misjudged the time (owner, 12 November 2026).
const timeLeft = (deadlineAt, now) => { const minutes = Math.round((deadlineAt - now) / 60000);
  return !Number.isFinite(minutes) || minutes < 0 ? '' : ` About ${minutes} ${minutes === 1 ? 'minute is' : 'minutes are'} left.${minutes >= 3 ? ' That is time to work in: when one piece is done and your mission still has more you could find or fix, take the next piece instead of stopping.' : ''}`; };
// Wording alone did not keep agents working: they ended a turn inside two minutes and left the rest "for the next run",
// and asked only to "take the next piece" they answered that nothing was left without looking (owner, 12 November 2026).
const KEEP_GOING = 'Your last turn ended with the minutes above still left in the job. There is no later run to leave work for: this job is the run. Do not judge the time yourself: those minutes are what you have, and one more piece fits in them. Look before you answer: what you listed as not done yet, list_tasks for an open task, the mission for a part nobody has covered, and a teammate\'s open pull request you have not checked yet (check it against the code and tell them with send_message what you find). Take the first of these that gives you something to do. Only if all of them give nothing, say what you checked in one line and end the turn; you are not asked again until something changes.\n';
export function controllerPrompt({scope,deadlineAt,steering,notices,trigger,inbox,now,keepGoing}) {
  const parts={mission:`Human-approved mission: ${scope}\n`,runtime:trigger === 'pause_update' ? PAUSE_UPDATE : `The job's time ends at ${new Date(deadlineAt).toISOString()}.${timeLeft(deadlineAt, now)} If it passes during this turn, finish the turn; no new turn starts until the owner adds time.\n${keepGoing === true ? KEEP_GOING : ''}${inbox ? `Current turn context (runtime observation, not message contents):
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
