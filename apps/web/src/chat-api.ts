import type { SessionUser } from './session-identity';
import { ApiError, session } from './api';
import type { Route } from './route';
export type { ChatReaction, ChatAttachment, ChatReply, ChatPointer, ChatExtras } from './chat-types';
export async function chatRequest<T>(user:SessionUser|null,projectId:string,path:string,body?:unknown):Promise<T> {
  const token=user?await user.getIdToken():null;
  if(user&&session.currentUid()!==user.uid)throw new ApiError(401,'Your signed-in account changed.');
  const response=await fetch(`/api/project-chat/${projectId}${path}`,{method:body===undefined?'GET':'POST',headers:{...(token?{authorization:`Bearer ${token}`} : {}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15_000)});
  const result=await response.json().catch(()=>null);
  if(user&&session.currentUid()!==user.uid)throw new ApiError(401,'Your signed-in account changed.');
  if(!response.ok)throw new ApiError(response.status,result?.message??'This chat action could not be confirmed. Try again.');
  return result;
}
export const chatMessageRoute=(projectId:string,channel:'human'|'agent',id:string,threadId?:string):Route=>({view:'project',projectId,section:channel==='human'?'overview':'conversations',agent:null,q:null,thread:channel==='agent'?(threadId??id):null,message:id});
