// Starts real inference only after explicit model/effort/scenario selection.
import {contextCaptureOptions,captureContextOverhead,contextCapturePlan} from './context-overhead-capture.mjs';
const stop=new AbortController();
process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
try{
 if(process.argv.length===3&&process.argv[2]==='--describe'){console.log(JSON.stringify(contextCapturePlan,null,2));}
 else{
 const options=contextCaptureOptions(process.argv.slice(2));
 const result=await captureContextOverhead(options,{signal:stop.signal,onProgress:value=>console.log(JSON.stringify(value))});
 console.log(JSON.stringify({phase:'completed',directory:result.root,realModels:true,syntheticCoordination:true}));
 }
}catch(error){console.error(JSON.stringify({phase:'failed',directory:error.root??null,message:'Comparison not completed. Check explicit options or inspect the private experiment directory; raw provider errors are not printed.'}));process.exitCode=1;}
