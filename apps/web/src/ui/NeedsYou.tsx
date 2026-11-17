import { subscribeRealtime } from '../realtime';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionUser } from '../session-identity';
import type { HumanRequest, HumanRequestPage, HumanRequestStatus } from '@minions/contracts';
import { ApiError, session, needsYou } from '../api';
import { hold, mayLeaveProject, projectRoute, type Route } from '../route';
import { NavLink, time } from '../shared';
import { Button } from './Button';
import { PathHeading } from './PathHeading';
import { Check, LockKeyhole, PenLine, Users, ShieldAlert, CheckCircle2, Circle } from './icons';
import { useInvitedProfile } from './use-invited-profile';
import { needsYouKey, useNeedsYouPage } from './use-needs-you-page';
import './needs-you.css';
import { projectRequestSignals } from './project-request-signals';
import { useMyWorkers, type MyWorkers } from './MyWorkerControls';
import { readOpenRequests } from './read-open-requests';
import { shortAge } from './notifications-bell';
import { AgentRunActions } from './AgentRunControls';

// This adapter discovers the invited profile before sending any fenced reads or answers.
// The page lists requests across projects; inside a project they are pinned in Communication (owner, 12 November 2026).
export function NeedsYou({ user, go }: { user: SessionUser; go?: (route: Route) => void }) {
  const { profileId, error, retry, deny } = useInvitedProfile(user);
  if (session.currentUid() !== user.uid) return null;
  return <section className="k42-needs-you" aria-label="Needs you">
    <PathHeading title="Needs you" go={go} />
    <p className="k42-needs-intro">Requests waiting for your help, and the ones you answered.</p>
    {error ? <div role="alert"><p>{error}</p><Button onClick={retry}>Check access again</Button></div>
      : profileId ? <RequestInbox key={`${user.uid}:${profileId}`} user={user} profileId={profileId} go={go} onDenied={deny} /> : <p role="status">Checking access…</p>}
  </section>;
}
function RequestInbox({user,profileId,go,onDenied}: {user:SessionUser;profileId:string;go?: (route:Route)=>void;onDenied:(error:Error)=>void}) {
  const [status,setStatus] = useState<HumanRequestStatus>('open'), [earlier,setEarlier] = useState<HumanRequestPage|null>(null), [error,setError] = useState<string|null>(null), [busy,setBusy] = useState(false), [retry,setRetry] = useState(0), [browsingEarlier,setBrowsingEarlier] = useState(false);
  const generation=useRef(0), mounted=useRef(true);
  const client=useQueryClient();
  const query = (cursor?:string|null) => '?' + new URLSearchParams({status,...(cursor ? {cursor}: {})});
  // The latest page is shared with the bell; earlier pages are a snapshot this inbox keeps while browsing them.
  const latest=useNeedsYouPage(user,profileId,query(),{enabled:!browsingEarlier});
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
  },[user.uid,profileId,status,retry]);
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
    {page?.items.length===0 && !shownError && <div className="k42-needs-empty"><h2>{status==='open' ? 'Nothing waiting here' : `No ${status} requests`}</h2><p>Your agents ask here when required work is blocked and they need your help.</p></div>}
    {browsingEarlier && <div className="k42-needs-history"><p className="muted">Earlier requests are a snapshot. Return to latest for new requests and status changes.</p><Button onClick={()=>{if(mayLeaveProject())reload();}}>Back to latest</Button></div>}
    <div className="k42-needs-list">{page?.items.map(item=><RequestItem key={item.id} request={item} user={user} profileId={profileId} go={go} showProject onAnswered={answered} onDenied={fail} />)}</div>
    {page?.next && <Button disabled={busy} onClick={()=>void more()}>{busy?'Loading…':'More requests'}</Button>}
  </>;
}
export function RequestItem({request,user,profileId,go,onAnswered,onDenied,readOnly=false,workers,onProtectedChange,showProject=false}: {request:HumanRequest;user:SessionUser;profileId:string;go?: (route:Route)=>void;onAnswered:(request:HumanRequest)=>void;onDenied:(error:unknown)=>void;readOnly?:boolean;workers?:MyWorkers;onProtectedChange?:(id:string,protectedAnswer:boolean)=>void;showProject?:boolean}) {
  const [answeredNow,setAnsweredNow]=useState(false);
  const options=request.suggestedOptions ?? [];
  const [selected,setSelected]=useState<number[]>([]), [own,setOwn]=useState(!options.length);
  const [body,setBody]=useState(''), [busy,setBusy]=useState(false), [error,setError]=useState<string|null>(null);
  const pending=useRef<{expected_revision:number;client_request_id:string;body:string;option_indices?:number[];custom_answer?:string}|null>(null), live=useRef(true);
  const report=request.moderation, mine=request.assigneeProfileId===profileId;
  const answering=request.status==='open' && !readOnly && (!!report || mine);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const multiple=request.selectionMode==='multiple';
  const validAnswer=report ? !!body.trim() : (selected.length>0 || own) && (!own || !!body.trim());
  const dirty=!!body || selected.length>0 || own && !!options.length;
  useEffect(()=>dirty || pending.current ? hold() : undefined,[dirty,busy]);
  useEffect(()=>onProtectedChange?.(request.id,dirty || !!pending.current),[request.id,dirty,busy,onProtectedChange]);
  const reset=()=>{setBody('');setSelected([]);setOwn(!options.length);};
  function choose(index:number) {
    if(multiple)setSelected(current=>current.includes(index)?current.filter(value=>value!==index):[...current,index].sort((a,b)=>a-b));
    else {setSelected([index]);setOwn(false);setBody('');}
  }
  function chooseOwn(on=!own) { if(multiple)setOwn(on); else if(on){setOwn(true);setSelected([]);} }
  async function answer() {
    if(busy || !pending.current && !validAnswer)return;
    const input=pending.current ?? {expected_revision:request.revision,client_request_id:crypto.randomUUID(),
      ...(report ? {body:body.trim()} : {body:'',option_indices:selected,...(own ? {custom_answer:body.trim()} : {})})};
    pending.current=input;setBusy(true);setError(null);
    try {
      const result=await needsYou<{request:HumanRequest}>(user,profileId,`/${request.id}/answer`,input);
      if(live.current){pending.current=null;reset();setOwn(false);setAnsweredNow(true);onAnswered(result.request);}
    } catch(failure) { if(live.current) {setError((failure as Error).message);if(failure instanceof ApiError && [401,403,404].includes(failure.status))onDenied(failure);if(failure instanceof ApiError && failure.status===409){pending.current=null;reset();}} }
    finally{if(live.current)setBusy(false);}
  }
  const locked=busy || !!pending.current;
  // One paragraph under the question: why it is stuck, then what was tried (owner, 12 November 2026).
  const detail=[request.context,request.attempted].filter(Boolean).join(' ');
  const visibility=report?<><ShieldAlert size={14} aria-hidden="true"/>Reviewers only</>:request.visibility==='private'?<><LockKeyhole size={14} aria-hidden="true"/>Only you</>:<><Users size={14} aria-hidden="true"/>Project can see</>;
  return <article className="k42-needs-item" data-waiting={answering && !report ? 'true' : undefined} aria-label={`${request.agentName}: ${request.title}`}>
    <header className="k42-needs-who">
      <span><strong>{request.agentName}</strong><span className="k42-needs-arrow" aria-label="to"> → </span><strong>{report?'Reviewers':mine?'You':'Project owner'}</strong></span>
      <span className="k42-needs-meta">{showProject && <span>{request.projectTitle}</span>}<time dateTime={new Date(request.createdAt).toISOString()} title={new Date(request.createdAt).toLocaleString()}>{shortAge(request.createdAt, Date.now())}</time><span className="k42-needs-visibility">{visibility}</span></span>
    </header>
    {report && <ModerationDetails request={request} go={go} />}
    {report && request.context && <p className="k42-needs-detail"><strong>Observations and uncertainty: </strong>{request.context}</p>}
    <h3 className="k42-needs-question">{report && 'Suggested response: '}{request.question}</h3>
    {!report && detail && <p className="k42-needs-detail">{detail}</p>}
    {answeredNow && request.answer && !request.answer.acknowledged && request.status==='answered' && !report && <AnswerConfirmation request={request} user={user} workers={workers} readOnly={readOnly} />}
    {request.answer && <div className="k42-needs-answer"><p><strong>{report?'Human review: ':mine?'You answered: ':'Answered: '}</strong>{request.answer.body}</p>{report ? <p className="muted">{time(request.answer.at)}</p> : <AnswerProgress request={request} />}</div>}
    {request.resolution && !report && <div className="k42-needs-answer"><p><strong>Resolved by {request.agentName}: </strong>{request.resolution.body}</p></div>}
    {answering ? <form onSubmit={event=>{event.preventDefault();void answer();}}>
      {!report && options.length>0 && <fieldset className="k42-needs-choices" disabled={locked}>
        <legend>{multiple?'Choose one or more':'Choose one'}</legend>
        {options.map((option,index)=><label key={index} className="k42-needs-choice">
          <input type={multiple?'checkbox':'radio'} name={`choices-${request.id}`} checked={selected.includes(index)} onChange={()=>choose(index)} />
          <span className="k42-needs-letter" aria-hidden="true">{String.fromCharCode(65+index)}</span><span className="k42-needs-choice-text">{option}</span><Check size={16} className="k42-needs-tick" aria-hidden="true"/>
        </label>)}
        <label className="k42-needs-choice is-own">
          <input type={multiple?'checkbox':'radio'} name={`choices-${request.id}`} checked={own} onChange={()=>chooseOwn()} aria-label="Something else" />
          <span className="k42-needs-letter" aria-hidden="true"><PenLine size={13}/></span>
          <textarea rows={1} maxLength={2000} value={body} readOnly={locked} aria-label="Write your own answer" placeholder="Something else…" onFocus={()=>chooseOwn(true)} onChange={event=>{chooseOwn(true);setBody(event.target.value);}} />
          <Check size={16} className="k42-needs-tick" aria-hidden="true"/>
        </label>
      </fieldset>}
      {(report || !options.length) && <textarea className="k42-needs-own" id={`answer-${request.id}`} rows={3} maxLength={2000} required value={body} readOnly={locked} onChange={event=>setBody(event.target.value)} aria-label={report?'Review outcome':'Your answer'} placeholder={report?'Review outcome…':'Tell the agent how to continue…'} />}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="k42-needs-send"><Button className="primary" disabled={busy || !pending.current && !validAnswer} type="submit">{busy?'Sending…':pending.current?'Retry saved response':report?'Review and resolve':'Send answer'}</Button>
        {!pending.current && dirty && options.length>0 && <Button type="button" onClick={reset}>Clear</Button>}
        <small>{report?'Recording a review resolves this report. It does not ban anyone, stop agents or change permissions.':'Guidance only. It does not change tool permissions.'}</small></div>
    </form> : request.status==='open' && !readOnly && <p className="muted">Waiting for the project owner’s answer. Other work can continue.</p>}
    {go && showProject && <p className="k42-needs-project-link"><NavLink to={report ? projectRoute(request.projectId,'overview') : projectRoute(request.projectId,'conversations')} go={go}>Open project</NavLink></p>}
  </article>;
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
  const target=subject.kind==='agent' ? projectRoute(request.projectId,'agents',subject.id,null) : null;
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

/** Open requests pinned at the top of Communication: an agent asking a person is a message to them (owner, 12 November 2026).
 * A request answered here stays in place with its receipt until the page is left. */
export function WaitingRequests({ user, requests, go, label, readOnly = false }: { user: SessionUser; requests: HumanRequest[]; go?: (route: Route) => void; label: ReactNode; readOnly?: boolean }) {
  const { profileId, deny } = useInvitedProfile(user);
  const [answered, setAnswered] = useState<Record<string, HumanRequest>>({});
  const workers = useMyWorkers() ?? undefined;
  const shown = [...requests.map(request => answered[request.id] ?? request), ...Object.values(answered).filter(request => !requests.some(row => row.id === request.id))];
  if (!profileId || !shown.length || session.currentUid() !== user.uid) return null;
  return <section className="k42-needs-you k42-needs-waiting" aria-label="Waiting for an answer">
    <p className="k42-needs-label">{label}</p>
    <div className="k42-needs-list">{shown.map(request => <RequestItem key={request.id} request={request} user={user} profileId={profileId} go={go} readOnly={readOnly} workers={workers}
      onAnswered={next => setAnswered(current => ({ ...current, [next.id]: next }))} onDenied={failure => deny(failure as Error)} />)}</div>
  </section>;
}

/** Saved means available on the next check, not delivered or applied to a model turn. */
function AnswerConfirmation({ request, user, workers, readOnly }: { request: HumanRequest; user: SessionUser; workers?: MyWorkers; readOnly: boolean }) {
  const own = workers?.data?.agents.find(row => row.agentId === request.agentId);
  return <div className="k42-needs-sent" role="status"><span>Answer saved. {request.agentName} can read it on its next check. This does not change tool permissions.</span>
    {own && !readOnly && <AgentRunActions user={user} projectId={request.projectId} agent={own} controls={workers!} now={workers!.now} disabled={false} compact />}</div>;
}
