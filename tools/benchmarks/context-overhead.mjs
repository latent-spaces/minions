// Offline comparison of measured paired runs. Does not invoke models or write project analytics.
import { normalizeReportedUsage } from '@minions/contracts';
const equalKeys=['provider','model','effort','clientVersion','scenarioDigest','fixtureDigest','sharedConfigDigest','sessionPhase'];
const count=value=>Number.isSafeInteger(value)&&value>=0;
function usage(turn){
  for(const key of ['input','output','cacheRead','cacheWrite'])if(turn[key]!==null&&!count(turn[key]))throw new TypeError('Use measured counters or null.');
  if(!['uncached','includes-cache'].includes(turn.inputSemantics))throw new TypeError('Identify native input accounting.');
  return normalizeReportedUsage({turns:1,input:turn.input??0,output:turn.output??0,cacheRead:turn.cacheRead??0,cacheWrite:turn.cacheWrite??0,inputSemantics:turn.inputSemantics,
    tokenCoverage:Object.fromEntries(['input','output','cacheRead','cacheWrite'].map(key=>[key,turn[key]===null?0:1]))});
}
export function compareContextOverhead(baseline,minions){
  if(baseline?.mode!=='direct'||minions?.mode!=='minions')throw new TypeError('Supply a direct baseline and a Minions run.');
  for(const key of equalKeys)if(typeof baseline[key]!=='string'||!baseline[key]||baseline[key].length>300||baseline[key]!==minions[key])throw new TypeError(`Unmatched ${key}.`);
  if(!Array.isArray(baseline.turns)||!Array.isArray(minions.turns)||!baseline.turns.length||baseline.turns.length!==minions.turns.length||baseline.turns.length>100)throw new TypeError('Match one to 100 turn pairs.');
  const pairs=baseline.turns.map((turn,index)=>{
    if(!/^[a-f0-9]{64}$/.test(turn?.resultDigest??'')||turn.resultDigest!==minions.turns[index]?.resultDigest)throw new TypeError(`Unmatched verified result for turn ${index+1}.`);
    const a=usage(turn),b=usage(minions.turns[index]);
    const difference=key=>a[key]&&b[key]?b[key].value-a[key].value:null;
    return {turn:index+1,phase:index===0?baseline.sessionPhase:'subsequent',baselineInput:a.input?.value??null,minionsInput:b.input?.value??null,
      inputOverhead:difference('input'),outputDifference:difference('output'),cacheReadDifference:difference('cacheRead'),cacheWriteDifference:difference('cacheWrite')};
  });
  return {schema:1,units:'tokens',configuration:Object.fromEntries(equalKeys.map(key=>[key,baseline[key]])),pairs,
    interpretation:'Observed difference for this matched scenario only; no per-source token allocation or retained-context claim.'};
}
