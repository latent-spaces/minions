import { subscribeRealtime } from '../realtime';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionUser } from '../session-identity';
import type { HumanRequest, HumanRequestPage, HumanRequestStatus } from '@mlswarm/contracts';
import { ApiError, session, needsYou } from '../api';
import { hold, mayLeaveProject, projectRoute, type Route } from '../route';
import { NavLink, time } from '../shared';
import { Button } from './Button';
import { PathHeading } from './PathHeading';
import { ChevronDown, LockKeyhole, Users, ShieldAlert, CheckCircle2, Circle } from 'lucide-react';
import { useInvitedProfile } from './use-invited-profile';
import { needsYouKey, useNeedsYouPage } from './use-needs-you-page';
import './needs-you.css';
import { projectRequestSignals } from './project-request-signals';
import { useMyWorkers, type MyWorkers } from './MyWorkerControls';
import { readOpenRequests } from './read-open-requests';
import { AgentRunActions } from './AgentRunControls';

// This adapter discovers the invited profile before sending any fenced reads or answers.
export function NeedsYou({ user, projectId, go, readOnly = false }: { user: SessionUser; projectId?: string; go?: (route: Route) => void; readOnly?: boolean }) {
  const { profileId, error, retry, deny } = useInvitedProfile(user);
  if (session.currentUid() !== user.uid) return null;
  return <section className="k42-needs-you" aria-label="Needs you">
    {!projectId && <PathHeading title="Needs you" go={go} />}
    <p className="k42-needs-intro">{projectId ? 'Blockers and moderation reports for this project.' : 'Requests waiting for your help.'}</p>
    {error ? <div role="alert"><p>{error}</p><Button onClick={retry}>Check access again</Button></div>
      : profileId ? <RequestInbox key={`${user.uid}:${profileId}:${projectId ?? 'mine'}`} user={user} profileId={profileId} projectId={projectId} go={go} onDenied={deny} readOnly={readOnly} /> : <p role="status">Checking access…</p>}
  </section>;
}
function RequestInbox({user,profileId,projectId,go,onDenied,readOnly=false}: {user:SessionUser;profileId:string;projectId?:string;go?: (route:Route)=>void;onDenied:(error:Error)=>void;readOnly?:boolean}) {
  const [status,setStatus] = useState<HumanRequestStatus>('open'), [earlier,setEarlier] = useState<HumanRequestPage|null>(null), [error,setError] = useState<string|null>(null), [busy,setBusy] = useState(false), [retry,setRetry] = useState(0), [browsingEarlier,setBrowsingEarlier] = useState(false);
  const generation=useRef(0), mounted=useRef(true);
  const workers=useMyWorkers() ?? undefined, client=useQueryClient();
  const query = (cursor?:string|null) => '?' + new URLSearchParams({status,...(projectId ? {project_id:projectId} : {}),...(cursor ? {cursor}: {})});
  // The latest page is shared with the bell; earlier pages are a snapshot this inbox keeps while browsing them.
  const latest=useNeedsYouPage(user,profileId,query(),{enabled:!browsingEarlier,projectId});
  const page=browsingEarlier ? earlier : latest.data ?? null;
  const denied=(failure:unknown): failure is ApiError => failure instanceof ApiError && [401,403,404].includes(failure.status);
  function fail(failure:unknown) {
    if (denied(failure)) {setEarlier(null);onDenied(failure);}
    else setError((failure as Error).message);
  }
  useEffect(() => { if (denied(latest.error)) onDenied(latest.error); }, [latest.error]);
  useEffect(() => {
    mounted.current=true; ++generation.current; setEarlier(null);setError(null);setBusy(false);setBrowsingEarlier(false);
    return () => {mounted.current=false;++generation.current;};
  },[user.uid,profileId,projectId,status,retry]);
  const reload=()=>{setRetry(n=>n+1);void latest.refetch();};
  async function more() {
    if (!page?.next || busy) return; const from=page; setEarlier(previous=>browsingEarlier ? previous : from);setBrowsingEarlier(true);setBusy(true);const at=generation.current;
    try { const incoming=await needsYou<HumanRequestPage>(user,profileId,query(from.next)); if(mounted.current && at===generation.current)setEarlier(previous=>({items:[...new Map([...(previous?.items ?? []),...incoming.items].map(item=>[item.id,item])).values()],next:incoming.next})); }
    catch(failure){if(mounted.current && at===generation.current)fail(failure);}
    finally{if(mounted.current && at===generation.current)setBusy(false);}
  }
  const shownError=error ?? (latest.error && !denied(latest.error) ? latest.error.message : null);
  const answered=(request:HumanRequest)=>{
    const swap=<T extends HumanRequestPage|null|undefined>(current:T)=>current ? {...current,items:current.items.map(item=>item.id===request.id ? request:item)} : current;
    setEarlier(swap);client.setQueryData<HumanRequestPage>(needsYouKey(user.uid,profileId,query()),swap);
  };
  return <>
    <div className="k42-needs-filters" role="group" aria-label="Request status">{(['open','answered','resolved'] as const).map(value=><Button key={value} className="k42-needs-chip" aria-pressed={status===value} onClick={()=>{if(value!==status && mayLeaveProject())setStatus(value);}}>{value[0].toUpperCase()+value.slice(1)}</Button>)}</div>
    {shownError && <div role="alert"><p className="error">{shownError}</p><Button onClick={reload}>Try again</Button></div>}
    {!page && !shownError && <p role="status">Loading requests…</p>}
    {page?.items.length===0 && !shownError && <div className="k42-needs-empty"><h2>{status==='open' ? 'Nothing waiting here' : `No ${status} requests`}</h2><p>{projectId ? 'No blockers or private requests to you match this filter.' : 'Your agents ask here when required work is blocked and they need your help.'}</p></div>}
    {browsingEarlier && <div className="k42-needs-history"><p className="muted">Earlier requests are a snapshot. Return to latest for new requests and status changes.</p><Button onClick={()=>{if(mayLeaveProject())reload();}}>Back to latest</Button></div>}
    <div className="k42-needs-list">{page?.items.map(item=><RequestItem key={item.id} request={item} user={user} profileId={profileId} go={go} readOnly={readOnly} workers={projectId ? workers : undefined} onAnswered={answered} onDenied={fail} />)}</div>
    {page?.next && <Button disabled={busy} onClick={()=>void more()}>{busy?'Loading…':'More requests'}</Button>}
  </>;
}
export function RequestItem({request,user,profileId,go,onAnswered,onDenied,readOnly=false,workers,onProtectedChange}: {request:HumanRequest;user:SessionUser;profileId:string;go?: (route:Route)=>void;onAnswered:(request:HumanRequest)=>void;onDenied:(error:unknown)=>void;readOnly?:boolean;workers?:MyWorkers;onProtectedChange?:(id:string,protectedAnswer:boolean)=>void}) {
  const [answeredNow,setAnsweredNow]=useState(false);
  const [selected,setSelected]=useState<number[]>([]), [own,setOwn]=useState(!request.suggestedOptions?.length), [note,setNote]=useState('');
  const [body,setBody]=useState(''), [busy,setBusy]=useState(false), [error,setError]=useState<string|null>(null);
  const pending=useRef<{expected_revision:number;client_request_id:string;body:string;option_indices?:number[];custom_answer?:string}|null>(null), live=useRef(true);
  const privateRequest=request.visibility==='private';
  const report=request.moderation;
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const multiple=request.selectionMode==='multiple';
  const validAnswer=report ? !!body.trim() : (selected.length>0 || own) && (!own || !!body.trim()) && (own ? body.trim().length : 0)+(selected.length ? note.trim().length : 0)<=2000;
  const dirty=!!body || !!note || selected.length>0 || own && !!request.suggestedOptions?.length;
  useEffect(()=>dirty || pending.current ? hold() : undefined,[dirty,busy]);
  useEffect(()=>onProtectedChange?.(request.id,dirty || !!pending.current),[request.id,dirty,busy,onProtectedChange]);
  function choose(index:number) {
    if(multiple)setSelected(current=>current.includes(index)?current.filter(value=>value!==index):[...current,index].sort((a,b)=>a-b));
    else {setSelected([index]);setOwn(false);}
  }
  async function answer() {
    if(busy || !pending.current && !validAnswer)return;
    const input=pending.current ?? {expected_revision:request.revision,client_request_id:crypto.randomUUID(),
      ...(report ? {body:body.trim()} : {body:selected.length ? note.trim() : '',option_indices:selected,...(own ? {custom_answer:body.trim()} : {})})};
    pending.current=input;setBusy(true);setError(null);
    try {
      const result=await needsYou<{request:HumanRequest}>(user,profileId,`/${request.id}/answer`,input);
      if(live.current){pending.current=null;setBody('');setNote('');setSelected([]);setOwn(false);setAnsweredNow(true);onAnswered(result.request);}
    } catch(failure) { if(live.current) {setError((failure as Error).message);if(failure instanceof ApiError && [401,403,404].includes(failure.status))onDenied(failure);if(failure instanceof ApiError && failure.status===409){pending.current=null;setBody('');setNote('');setSelected([]);setOwn(!request.suggestedOptions?.length);}} }
    finally{if(live.current)setBusy(false);}
  }
  return <details className="k42-needs-item">
    <summary><span className="k42-needs-kind" aria-hidden="true">{report?<ShieldAlert size={19}/>:privateRequest?<LockKeyhole size={19}/>:<Users size={19}/>}</span><span className="k42-needs-summary"><strong>{request.title}</strong><span>{request.agentName} · {request.projectTitle}</span></span><span className="k42-needs-visibility">{report?'Moderation · Reviewers only':privateRequest?'Private · Only you':'Project blocker'}</span><ChevronDown size={18} className="k42-needs-chevron" aria-hidden="true"/></summary>
    <div className="k42-needs-detail"><p className="muted">Requested {time(request.createdAt)} · {request.status[0].toUpperCase()+request.status.slice(1)}</p>
      {report && <ModerationDetails request={request} go={go} />}
      {report && request.context && <p><strong>Observations and uncertainty: </strong>{request.context}</p>}
      <p className="k42-needs-question">{report && <strong>Suggested response: </strong>}{request.question}</p>
      {!report && <BlockerContext request={request} />}
      {answeredNow && request.answer && !request.answer.acknowledged && request.status==='answered' && !report && <AnswerConfirmation request={request} user={user} workers={workers} readOnly={readOnly} />}
      {request.answer && <div className="k42-needs-answer"><h3>{report?'Human review':'Your answer'}</h3><p>{request.answer.body}</p>{report ? <p className="muted">{time(request.answer.at)}</p> : <AnswerProgress request={request} />}</div>}
      {request.resolution && !report && <div className="k42-needs-answer"><h3>Resolved by {request.agentName}</h3><p>{request.resolution.body}</p></div>}
      {request.status==='open' && !readOnly && (report || request.assigneeProfileId===profileId ? <form onSubmit={event=>{event.preventDefault();void answer();}}>
        {!report && <fieldset className="k42-needs-options" disabled={busy || !!pending.current}>
          <legend>{multiple?'Choose one or more':'Choose one'}</legend>
          {(request.suggestedOptions ?? []).map((option,index)=><label key={index} className="k42-needs-option">
            <input type={multiple?'checkbox':'radio'} name={`choices-${request.id}`} checked={selected.includes(index)} onChange={()=>choose(index)} />
            <span>{option}</span>
          </label>)}
          <label className="k42-needs-option">
            <input type={multiple?'checkbox':'radio'} name={`choices-${request.id}`} checked={own} onChange={()=>{if(multiple)setOwn(value=>!value);else{setOwn(true);setSelected([]);}}} />
            <span>Write my own answer</span>
          </label>
        </fieldset>}
        {(report || own) && <><label htmlFor={`answer-${request.id}`}>{report?'Review outcome':'Your answer'}</label><textarea id={`answer-${request.id}`} rows={3} maxLength={report?2000:Math.max(0,2000-(selected.length?note.length:0))} required value={body} readOnly={busy || !!pending.current} onChange={event=>setBody(event.target.value)} placeholder={report?undefined:'Tell the agent how to continue…'} /></>}
        {!report && selected.length>0 && <><label htmlFor={`note-${request.id}`}>Optional note</label><textarea id={`note-${request.id}`} rows={3} maxLength={Math.max(0,2000-(own?body.length:0))} value={note} readOnly={busy || !!pending.current} onChange={event=>setNote(event.target.value)} placeholder="Add context…" /></>}
        <p className="k42-needs-note">{report?'Recording a review resolves this report. It does not ban anyone, stop agents or change permissions.':'Your answer gives guidance. It does not change local tool permissions.'}</p>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="actions"><Button className="primary" disabled={busy || !pending.current && !validAnswer} type="submit">{busy?'Sending…':pending.current?'Retry saved response':report?'Review and resolve':'Send answer'}</Button>{!pending.current && dirty && <Button type="button" onClick={()=>{setBody('');setNote('');setSelected([]);setOwn(!request.suggestedOptions?.length);}}>Discard</Button>}</div>
      </form> : <p className="muted">Waiting for the project owner’s answer. Other work can continue.</p>)}
      {go && <p className="k42-needs-project-link"><NavLink to={projectRoute(request.projectId,'needs-you')} go={go}>Open project inbox</NavLink></p>}
    </div>
  </details>;
}

function BlockerContext({request}: {request:HumanRequest}) {
  return <div className="k42-needs-context" aria-label="Request context">
    {([{kind:'Blocked',title:request.blockerTitle ?? 'Why this work is blocked',body:request.context},
      {kind:'Tried',title:request.attemptedTitle ?? 'What the agent already tried',body:request.attempted}]).filter(item=>item.body).map(item=><details key={item.kind}>
      <summary><strong>{item.kind}</strong><span>{item.title}</span><ChevronDown size={16} aria-hidden="true" /></summary>
      <p>{item.body}</p>
    </details>)}
  </div>;
}

function AnswerProgress({request}: {request:HumanRequest}) {
  const acknowledged=request.answer?.acknowledged, resolved=request.status==='resolved';
  const steps=[{label:'Answer saved',complete:true},
    {label:acknowledged?'Agent acknowledged':resolved?'No acknowledgment recorded':'Awaiting acknowledgment',complete:!!acknowledged},
    {label:resolved?'Resolved':'Resolution pending',complete:resolved}];
  return <div className="k42-needs-receipt" role="status">
    <ol aria-label="Answer progress">{steps.map((step,index)=><li key={index} data-complete={step.complete}>
      {step.complete?<CheckCircle2 size={16} aria-hidden="true"/>:<Circle size={16} aria-hidden="true"/>}<span>{step.label}</span>
    </li>)}</ol>
    {acknowledged && <p className="muted">{request.agentName} acknowledged your answer · {time(acknowledged.at)}</p>}
  </div>;
}

function ModerationDetails({request,go}: {request:HumanRequest;go?: (route:Route)=>void}) {
  const report=request.moderation!, subject=report.subject;
  const target=subject.kind==='agent' ? projectRoute(request.projectId,'agents',subject.id,null,'all') : null;
  return <div className="k42-needs-answer">
    <h3>Flagged {subject.kind}: {go&&target?<NavLink to={target} go={go}>{subject.name}</NavLink>:subject.name}</h3>
    {subject.ownerProfileId && <p>Agent of {subject.ownerName ?? 'a removed person'}</p>}
    <p>{({security:'Security concern',conduct:'Community conduct',project_rules:'Project rules'})[report.category]} · Not a confirmed finding</p>
    <ul>{report.evidence.map((item,i)=>{
      if(item.kind==='repository') {
        let safe=false;try{const url=new URL(item.reference);safe=url.origin==='https://github.com'&&!url.username&&!url.password&&!url.search;}catch{}
        return <li key={i}>{safe?<a href={item.reference} target="_blank" rel="noreferrer">Repository evidence</a>:'Repository reference unavailable'}</li>;
      }
      const to=projectRoute(request.projectId,item.kind==='agent_message'?'conversations':'overview');
      if(to.view==='project'){if(item.kind==='agent_message'){to.thread=item.reference;to.message=item.reference;}}
      return <li key={i}>{go?<NavLink to={to} go={go}>{item.kind==='agent_message'?'Agent message':'Project update'}: {item.reference}</NavLink>:`${item.kind}: ${item.reference}`}</li>;
    })}</ul>
  </div>;
}

const NO_REQUESTS = { count: 0, more: false, agentIds: [], waiting: [], requests: [] };

/** Follow every bounded page so agent activation includes all server-visible outstanding requests.
 * Preserve 15 s reconciliation: active blockers can sit beyond the realtime query windows. */
export function useOpenRequests(user: SessionUser, projectId: string, active: boolean): { count: number; more: boolean; agentIds: string[]; waiting: HumanRequest[]; requests: HumanRequest[]; ready: boolean; error: string | null; retry: () => void } {
  const { profileId, error: accessError, retry: retryAccess, deny } = useInvitedProfile(user);
  const key = `${user.uid}:${profileId}:${projectId}`;
  const [state, setState] = useState<{ key: string; count: number; more: boolean; agentIds: string[]; waiting: HumanRequest[]; requests: HumanRequest[] } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null), [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { if (!profileId) retryAccess(); setAttempt(value => value + 1); }, [profileId, retryAccess]);
  useEffect(() => {
    if (!active || !profileId || session.currentUid() !== user.uid) return;
    let current = true, reading = false, again = false;
    async function load() {
      if (reading) { again = true; return; }
      if (document.visibilityState === 'hidden') return; reading = true;
      try {
        const items = await readOpenRequests(cursor => needsYou<HumanRequestPage>(user, profileId!, '?' + new URLSearchParams({ status: 'open', project_id: projectId, ...(cursor ? {cursor} : {}) })), () => current);
        const page = {items, next: null};
        if (current && session.currentUid() === user.uid) { setState({ key, ...projectRequestSignals(page, profileId!) }); setFailure(null); }
      } catch (error) {
        if (current) {
          // A transport failure must not unmount a form with a draft or exact retry.
          // Access refusal does clear private observations immediately.
          if (error instanceof ApiError && [401, 403, 404].includes(error.status)) { setState(null); deny(error); }
          setFailure({ key, message: (error as Error).message });
        }
      }
      finally { reading = false; if (again && current) { again = false; void load(); } }
    }
    void load(); const timer = setInterval(() => void load(), 15000);
    const stop = subscribeRealtime(user, projectId, topics => { if (topics.includes('needs-you')) void load(); });
    return () => { current = false; clearInterval(timer); stop(); };
  }, [user.uid, profileId, projectId, active, key, attempt, deny]);
  const observed = state?.key === key && active ? state : null;
  return { ...(observed ?? NO_REQUESTS), ready: !!observed, error: accessError ?? (failure?.key === key ? failure.message : null), retry };
}

/** Owner steering stays private to one agent (F7, 20 October 2026). An agent waiting on this person's answer
 * shows its request beside the steering box, so the decision is recorded on the request where the project can see it. */
export function WaitingRequests({ user, requests, go }: { user: SessionUser; requests: HumanRequest[]; go?: (route: Route) => void }) {
  const { profileId, deny } = useInvitedProfile(user);
  const [answered, setAnswered] = useState<Record<string, HumanRequest>>({});
  if (!profileId || !requests.length || session.currentUid() !== user.uid) return null;
  return <div className="k42-needs-you k42-needs-waiting">
    <p className="k42-needs-note">Waiting on your answer. Answer here to record it on the request{requests.some(r => r.visibility !== 'private') ? ', where the whole project can see it' : ''}. Steering reaches only this agent.</p>
    <div className="k42-needs-list">{requests.map(request => <RequestItem key={request.id} request={answered[request.id] ?? request} user={user} profileId={profileId} go={go}
      onAnswered={next => setAnswered(current => ({ ...current, [next.id]: next }))} onDenied={failure => deny(failure as Error)} />)}</div>
  </div>;
}

/** Saved means available on the next check, not delivered or applied to a model turn. */
function AnswerConfirmation({ request, user, workers, readOnly }: { request: HumanRequest; user: SessionUser; workers?: MyWorkers; readOnly: boolean }) {
  const own = workers?.data?.agents.find(row => row.agentId === request.agentId);
  return <div className="k42-needs-sent" role="status"><span>Answer saved. {request.agentName} can read it on its next check. This does not change tool permissions.</span>
    {own && !readOnly && <AgentRunActions user={user} projectId={request.projectId} agent={own} controls={workers!} now={workers!.now} disabled={false} compact />}</div>;
}
