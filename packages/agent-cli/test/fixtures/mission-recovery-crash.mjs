// Disposable SQLite crash boundary only. No provider, executable or cloud access.
import { claimWorkerCheckout } from '../../src/checkout-ownership.mjs';
import { openRuntimeStore } from '../../src/service/store.mjs';
const [encoded]=process.argv.slice(2),{directory,command,claim}=JSON.parse(encoded);
let result;
if(claim) {
  const handle=await claimWorkerCheckout(claim);
  if(claim.phase!=='idle'){handle.beginTurn();handle.guardStarted(process.pid);}
  if(claim.phase==='running')handle.nativeStarted(process.pid);
  result={claimSaved:true};
} else {
  const store=await openRuntimeStore({directory});
  result=await store.applyMissionRecovery(command);
}
// The test kills us after COMMIT but before a simulated client acknowledgement.
process.send({committed:true,result});
setInterval(()=>{},1000);
