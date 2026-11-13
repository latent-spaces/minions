import type { PublishedUpdate } from '@mlswarm/contracts';
export type UpdateSeen = {id:string;publishedAt:number};
export const updateSeenKey = (userId:string,projectId:string) => `mlswarm:updates-seen:v1:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`;
export function parseUpdateSeen(value:string|null):UpdateSeen|null {
  try { const marker=JSON.parse(value??'null');return marker&&typeof marker.id==='string'&&marker.id.length>0&&marker.id.length<=200&&Number.isFinite(marker.publishedAt)&&marker.publishedAt>=0?{id:marker.id,publishedAt:marker.publishedAt}:null; }
  catch { return null; }
}
export const newerUpdate = (item:UpdateSeen,seen:UpdateSeen|null) => !seen||item.publishedAt>seen.publishedAt||item.publishedAt===seen.publishedAt&&item.id.localeCompare(seen.id)>0;
export function unseenUpdates(items:Pick<PublishedUpdate,'id'|'publishedAt'>[],seen:UpdateSeen|null,next:string|null) {
  const count=items.filter(item=>newerUpdate(item,seen)).length;
  // Do not present a loaded-page lower bound as an exact count of all history.
  return {count,hasMore:count>0&&!!next&&items.every(item=>newerUpdate(item,seen))};
}
