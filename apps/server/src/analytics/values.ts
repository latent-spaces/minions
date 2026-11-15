import { PROMPT_SOURCES, CONTEXT_TOOL_NAMES, USAGE_METRICS, normalizeReportedUsage, type AnalyticsValues } from '@minions/contracts';
import type { LastTurn } from '../v2/records.js';
export const emptyValues = (): AnalyticsValues => ({nativeReports:0,nativeLastInputMax:null,nativeCompactions:0,promptSourceReports:0,promptSources:Object.fromEntries(PROMPT_SOURCES.map(key=>[key,0])) as AnalyticsValues['promptSources'],mcpReports:0,mcpTools:{},reports:0,outcomes:{succeeded:0,failed:0,timed_out:0,budget_cap:0},
  metrics:Object.fromEntries(USAGE_METRICS.map(key=>[key,{sum:0,known:0,partial:0}])) as AnalyticsValues['metrics']});
export function mergeValues(target: AnalyticsValues, value: AnalyticsValues): AnalyticsValues {
  target.reports += value.reports;
  target.nativeReports+=value.nativeReports;target.nativeCompactions+=value.nativeCompactions;
  if(value.nativeLastInputMax!==null)target.nativeLastInputMax=Math.max(target.nativeLastInputMax??0,value.nativeLastInputMax);
  target.promptSourceReports+=value.promptSourceReports;target.mcpReports+=value.mcpReports;
  for(const key of PROMPT_SOURCES) target.promptSources[key]+=value.promptSources[key];
  for(const name of CONTEXT_TOOL_NAMES) if(value.mcpTools[name]) {
    const tool=target.mcpTools[name]??={calls:0,argumentBytes:0,responseTextBytes:0,refusals:0,catalogDeliveries:0,definitionBytes:0};
    for(const key of ['calls','argumentBytes','responseTextBytes','refusals','catalogDeliveries','definitionBytes'] as const)tool[key]+=value.mcpTools[name]![key];
  }
  for (const key of Object.keys(target.outcomes) as (keyof AnalyticsValues['outcomes'])[]) target.outcomes[key] += value.outcomes[key];
  for (const key of USAGE_METRICS) {
    target.metrics[key].sum += value.metrics[key].sum; target.metrics[key].known += value.metrics[key].known; target.metrics[key].partial += value.metrics[key].partial;
    if (!Number.isFinite(target.metrics[key].sum) || target.metrics[key].sum > Number.MAX_SAFE_INTEGER) throw new Error('Analytics counter overflow.');
  }
  return target;
}
export function turnValues(turn: LastTurn): AnalyticsValues {
  const usage = turn.usage;
  if (!usage) throw new Error('Receipt has no usage.');
  const value=emptyValues(); value.reports=1; value.outcomes[turn.outcome]=1;
  if(usage.nativeContext){value.nativeReports=1;value.nativeLastInputMax=usage.nativeContext.lastInputTokens;value.nativeCompactions=usage.nativeContext.completedCompactions;}
  const tokens=usage.tokens;
  const normalized=normalizeReportedUsage({turns:1,input:tokens?.input??0,output:tokens?.output??0,cacheRead:tokens?.cacheRead??0,cacheWrite:tokens?.cacheWrite??0,
    inputSemantics:usage.inputSemantics,tokenCoverage:{input:tokens?.input!=null?1:0,output:tokens?.output!=null?1:0,cacheRead:tokens?.cacheRead!=null?1:0,cacheWrite:tokens?.cacheWrite!=null?1:0}});
  for (const key of ['input','output','cacheRead','cacheWrite'] as const) if(normalized[key]) value.metrics[key]={sum:normalized[key]!.value,known:1,partial:0};
  value.metrics.seconds={sum:usage.seconds,known:1,partial:0};
  if(usage.toolCalls!==undefined) value.metrics.toolCalls={sum:usage.toolCalls,known:1,partial:usage.toolScope==='provider-stream'?0:1};
  if(usage.context) {
    if(usage.context.promptSources){value.promptSourceReports=1;value.promptSources={...usage.context.promptSources};value.metrics.steeringBytes={sum:usage.context.promptSources.steering,known:1,partial:1};}
    if(usage.context.byTool){
      value.mcpReports=1;
      for(const {name,...tool} of usage.context.byTool)value.mcpTools[name]=tool;
      value.metrics.conversationResponseBytes={sum:usage.context.byTool.filter(t=>['read_thread','read_agent_inbox'].includes(t.name)).reduce((n,t)=>n+t.responseTextBytes,0),known:1,partial:1};
      value.metrics.taskResponseBytes={sum:usage.context.byTool.filter(t=>['list_tasks','get_task','create_task','update_task','claim_task','release_task','comment_task','link_task'].includes(t.name)).reduce((n,t)=>n+t.responseTextBytes,0),known:1,partial:1};
    }
    for(const key of ['instructionBytes','turnPromptBytes','catalogBytes'] as const) value.metrics[key]={sum:usage.context[key],known:1,partial:1};
    value.metrics.toolResponseBytes={sum:usage.context.tools.reduce((n,t)=>n+t.responseTextBytes,0),known:1,partial:1};
  }
  return value;
}
