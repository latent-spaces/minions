import { CONTEXT_TOOL_NAMES, validPromptSources } from './turn-context.mjs';
// Numeric Minions-supplied context only; not the native client's full context window.
export const CONTEXT_CATEGORIES = ['project', 'discovery', 'updates', 'threads', 'messaging', 'checkpoints', 'coordination', 'other'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const count = (value, max = 1e15) => Number.isSafeInteger(value) && value >= 0 && value <= max;
export function validContextMeasurement(value) {
  const optional=['promptSources','steeringMessages','sessionMode','byTool'].filter(key=>Object.hasOwn(value??{},key));
  const metadata = value?.scope === 'minions-supplied' && value?.coverage === 'partial';
  if (!exact(value, [...optional,...(metadata ? ['scope', 'coverage'] : []), 'instructionBytes', 'turnPromptBytes', 'catalogRequests', 'catalogBytes', 'tools'])
    || !['instructionBytes', 'turnPromptBytes', 'catalogBytes'].every(key => count(value[key]))
    || !count(value.catalogRequests, 1e9) || !Array.isArray(value.tools) || value.tools.length > 8) return false;
  if(value.promptSources!==undefined&&!validPromptSources(value.promptSources,value.turnPromptBytes))return false;
  if(value.steeringMessages!==undefined&&!count(value.steeringMessages,64))return false;
  if(value.sessionMode!==undefined&&!['new','resumed'].includes(value.sessionMode))return false;
  if(value.byTool!==undefined){
    if(!Array.isArray(value.byTool)||value.byTool.length>CONTEXT_TOOL_NAMES.length)return false;
    const names=new Set();
    for(const tool of value.byTool){
      if(!exact(tool,['name','catalogDeliveries','definitionBytes','calls','argumentBytes','responseTextBytes','refusals'])||!CONTEXT_TOOL_NAMES.includes(tool.name)||names.has(tool.name)
        ||!['catalogDeliveries','calls','refusals'].every(key=>count(tool[key],1e9))||!['definitionBytes','argumentBytes','responseTextBytes'].every(key=>count(tool[key]))||tool.refusals>tool.calls)return false;
      names.add(tool.name);
    }
  }
  const categories = new Set();
  return value.tools.every(tool => {
    if (!exact(tool, ['category', 'calls', 'argumentBytes', 'responseTextBytes', 'refusals'])
      || !CONTEXT_CATEGORIES.includes(tool.category) || categories.has(tool.category)
      || !['argumentBytes', 'responseTextBytes'].every(key => count(tool[key]))
      || !count(tool.calls, 1e9) || !count(tool.refusals, 1e9) || tool.refusals > tool.calls) return false;
    categories.add(tool.category); return true;
  });
}

export function validNativeContext(value){
  return exact(value,['source','coverage','lastInputTokens','lastTotalTokens','modelContextWindow','observations','completedCompactions'])
    &&['codex-app-server','claude-stream-json'].includes(value.source)&&value.coverage==='partial-turn-stream'
    &&['lastInputTokens','lastTotalTokens','modelContextWindow'].every(key=>value[key]===null||count(value[key]))
    &&count(value.observations,1e9)&&count(value.completedCompactions,4096)
    &&(value.observations>0||value.completedCompactions>0);
}

// Optional observations must never invalidate an otherwise valid execution outcome.
export function fitContextTelemetry(outcome,maximumBytes){
  let next=outcome;
  for(const key of ['context','nativeContext'])if(next.usage?.[key]&&Buffer.byteLength(JSON.stringify(next))>maximumBytes){
    next={...next,usage:{...next.usage}};delete next.usage[key];
  }
  return next;
}
