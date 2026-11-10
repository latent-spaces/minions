// Offline only: reads bounded numeric capture records; never launches a model.
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {compareContextOverhead} from './context-overhead.mjs';
const options={};
try{
 const args=process.argv.slice(2);
 for(let i=0;i<args.length;i++){
  const name=args[i];
  if(!['--direct','--mlswarm','--out'].includes(name)||options[name])throw new Error('Use --direct FILE --mlswarm FILE --out NEW_FILE exactly once each.');
  const value=args[++i];if(!value||value.startsWith('--'))throw new Error('Each option requires a file path.');options[name]=resolve(value);
 }
 if(Object.keys(options).length!==3)throw new Error('Use --direct FILE --mlswarm FILE --out NEW_FILE.');
 const read=async path=>{
  const file=await open(path,'r');
  try{
   const data=Buffer.alloc(1_048_577);let length=0;
   while(length<data.length){const {bytesRead}=await file.read(data,length,data.length-length,length);if(!bytesRead)break;length+=bytesRead;}
   if(length===data.length)throw new Error('Capture records must be at most 1 MiB.');
   return JSON.parse(data.subarray(0,length).toString('utf8'));
  }finally{await file.close();}
 };
 const [direct,mlswarm]=await Promise.all([read(options['--direct']),read(options['--mlswarm'])]);
 const report=compareContextOverhead(direct,mlswarm);
 const file=await open(options['--out'],'wx',0o600);
 try{await file.writeFile(JSON.stringify(report,null,2)+'\n');}finally{await file.close();}
 console.log('Saved the offline comparison. No model was started or project analytics changed.');
}catch(error){
 // Files can contain private payloads; never echo JSON parse excerpts or input bodies.
 console.error(error instanceof TypeError?error.message:'Could not compare captures. Check the options, bounded JSON input files and unused output path.');
 process.exitCode=1;
}
