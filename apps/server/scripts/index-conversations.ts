import { pathToFileURL } from 'node:url';
// Release prerequisite: index existing agent messages only. Never reads private steering.
import { db, FieldPath, inProject } from '../src/firestore.js';
import { messagesV2 } from '../src/v2/records.js';
import { conversationEntries } from '../src/projects/steering.js';
export async function indexConversations(projectId: string) {
  if(!/^[a-f0-9]{64}$/.test(projectId))throw Error('Use the project ID.');
  return inProject(projectId,async()=>{
    let after:string|null=null,count=0;
    for(;;){let query=messagesV2().orderBy(FieldPath.documentId()).limit(200);if(after)query=query.startAfter(after);
      const page=await query.get();if(page.empty)break;
      for(const row of page.docs)await db.runTransaction(async tx=>{const ref=conversationEntries().doc(row.id);if(!(await tx.get(ref)).exists){tx.create(ref,{...row.data(),kind:'agent_message'});count++;}});
      after=page.docs.at(-1)!.id;
    }
    return count;
  });
}
const ids=process.argv.slice(2);
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url && ids.length){for(const id of ids)console.log(id,await indexConversations(id));}
