import type { ChatPointer } from './chat-types.js';

const compare=(a:ChatPointer,b:ChatPointer)=>a.createdAt-b.createdAt||(a.id<b.id?-1:a.id>b.id?1:0);

/** Coalesce positions actually observed by the reader, without retrying failures in a loop. */
export function createChatReadQueue(write:(through:ChatPointer)=>Promise<void>,options:{
  isCurrent:()=>boolean;confirmed:(through:ChatPointer)=>void;failed:(error:unknown)=>void;
}) {
  let pending:ChatPointer|null=null,confirmed:ChatPointer|null=null,running=false,disposed=false;
  const current=()=>!disposed&&options.isCurrent();
  async function drain() {
    if(running||!pending||!current())return;
    running=true;const through=pending;pending=null;
    try {
      await write(through);
      if(!current()){running=false;return;}
      if(!confirmed||compare(through,confirmed)>0)confirmed=through;
      options.confirmed(through);
    } catch(error) {
      if(current()) {
        if(!pending||compare(through,pending)>0)pending=through;
        options.failed(error);
      }
      // A fresh observation or explicit retry can retry the retained position.
      // Do not turn a failed request into a persistent network retry loop.
      running=false;return;
    }
    running=false;
    if(pending&&confirmed&&compare(pending,confirmed)<=0)pending=null;
    if(current()&&pending)void drain();
  }
  return {
    observe(through:ChatPointer) {
      if(!current()||confirmed&&compare(through,confirmed)<=0)return;
      if(!pending||compare(through,pending)>0)pending=through;
      void drain();
    },
    dispose(){disposed=true;pending=null;},
  };
}
