import type {ContextSummary, ContextTurnPage, NativeContextObservation} from '@mlswarm/contracts';

export function requestPressure(native: NativeContextObservation|null|undefined): number|null {
  const input=native?.lastInputTokens, window=native?.modelContextWindow;
  return typeof input==='number'&&Number.isFinite(input)&&input>=0&&typeof window==='number'&&Number.isFinite(window)&&window>0 ? input/window*100 : null;
}
export function pressureStats(turns:ContextTurnPage['turns']) {
  const values=turns.map(t=>requestPressure(t.nativeContext)).filter((v):v is number=>v!==null).sort((a,b)=>a-b);
  const middle=Math.floor(values.length/2);
  return {count:values.length,peak:values.length?values.at(-1)!:null,median:values.length?(values.length%2?values[middle]!:(values[middle-1]!+values[middle]!)/2):null};
}
// Fixed order and colors (validated categorical slots 1-8): a source keeps its color across agents, days and filters.
export const SOURCES=[
  {key:'instructions',label:'Instructions',color:'var(--series-1)'},{key:'prompt',label:'Turn prompt',color:'var(--series-2)'},
  {key:'steering',label:'Steering',color:'var(--series-3)'},{key:'definitions',label:'Tool definitions',color:'var(--series-4)'},
  {key:'tasks',label:'Task results',color:'var(--series-5)'},{key:'conversations',label:'Conversation results',color:'var(--series-6)'},
  {key:'other',label:'Other tools & guide',color:'var(--series-7)'},{key:'arguments',label:'Tool arguments',color:'var(--series-8)'},
  {key:'unsplit',label:'Tool results · unsplit',color:'var(--series-other)'},
] as const;
export type Source=typeof SOURCES[number];
const taskTools=['list_tasks','get_task','create_task','update_task','claim_task','release_task','comment_task','link_task'],conversationTools=['read_thread','read_agent_inbox'];
/** Measured supplied bytes per source, in fixed order; sources a report did not measure are absent, not zero. */
export function suppliedSources(context:ContextSummary|null):(Source&{bytes:number})[] {
  if(!context)return [];
  const bytes:Partial<Record<Source['key'],number>>={instructions:context.instructionBytes,prompt:context.turnPromptBytes-(context.promptSources?.steering??0),definitions:context.catalogBytes};
  if(context.promptSources)bytes.steering=context.promptSources.steering;
  if(context.byTool){
    bytes.tasks=0;bytes.conversations=0;bytes.other=0;bytes.arguments=0;
    for(const tool of context.byTool){
      bytes.arguments+=tool.argumentBytes;
      const key=taskTools.includes(tool.name)?'tasks':conversationTools.includes(tool.name)?'conversations':'other';
      bytes[key]=bytes[key]!+tool.responseTextBytes;
    }
  }else bytes.unsplit=context.tools.reduce((n,t)=>n+t.responseTextBytes,0);
  return SOURCES.filter(source=>bytes[source.key]!==undefined).map(source=>({...source,bytes:bytes[source.key]!}));
}
