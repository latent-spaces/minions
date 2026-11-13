import type { SessionUser } from './session-identity';
import { useCallback, useEffect, useState } from 'react';
import type { ProgressScreenshot } from '@mlswarm/contracts';
import type { Route } from './route';
import { ProjectUpdates } from './ui/ProjectProgress';
import { useProjectProgress } from './useProjectProgress';
import { readProjectScreenshot } from './progress-api';
import {newerUpdate,parseUpdateSeen,unseenUpdates,updateSeenKey,type UpdateSeen} from './update-seen';

// The project's Updates panel, beside every tab: what its agents posted, newest first (owner, 11 November 2026).
export function ProjectUpdatesFeed({ projectId, user, tick, active, observe=active, go, onPendingChange, onUnseenChange }: {
  projectId: string; user: SessionUser; tick: number; active: boolean; go: (route: Route) => void;
  observe?:boolean;onUnseenChange?:(count:number,hasMore:boolean)=>void;
  onPendingChange?: (count: number) => void;
}) {
  const updates = useProjectProgress(projectId, user, tick, observe);
  const key=updateSeenKey(user.uid,projectId);
  const readSeen=useCallback(()=>{try{return parseUpdateSeen(localStorage.getItem(key));}catch{return null;}},[key]);
  const [saved,setSaved]=useState<{key:string;marker:UpdateSeen|null}>(()=>({key,marker:readSeen()}));
  const marker=saved.key===key?saved.marker:readSeen();
  useEffect(()=>{
    setSaved({key,marker:readSeen()});
    const changed=(event:StorageEvent)=>{if(event.key===key||event.key===null)setSaved({key,marker:readSeen()});};
    window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);
  },[key,readSeen]);
  const seenLatest=useCallback((item:UpdateSeen)=>{
    const stored=readSeen(),latest=stored&&newerUpdate(stored,marker)?stored:marker;
    if(!newerUpdate(item,latest))return;
    try{localStorage.setItem(key,JSON.stringify(item));}catch{/* Keep seen state for this visit if storage is unavailable. */}
    setSaved({key,marker:item});
  },[key,marker,readSeen]);
  const badge=unseenUpdates(updates.page?.items??[],marker,updates.page?.next??null);
  useEffect(()=>{onUnseenChange?.(badge.count,badge.hasMore);},[badge.count,badge.hasMore,onUnseenChange]);
  const resolveScreenshot = useCallback((image: ProgressScreenshot) => readProjectScreenshot(projectId, user, image), [projectId, user]);
  return <ProjectUpdates projectId={projectId} {...updates} active={active} resolveScreenshot={resolveScreenshot} go={go} onPendingChange={onPendingChange} onSeenLatest={seenLatest} />;
}
