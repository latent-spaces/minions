import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionUser } from '../session-identity';
import { ApiError, session, owner, ownOwner } from '../api';
import { suggestAgentName, userPrefix } from '../agent-name';
import { projectRoute, type Route } from '../route';
import { NavLink } from '../shared';
import { availableProviders, computerOnline, validAgentGoal, validAgentModel, readSavedStart, startMessage, terminalStart, type Provider, type StartPayload, type StartRequest } from '../web-agent-start';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { CloseButton } from './CloseButton';
import { Bot, Check, Eye, Plus, SendHorizontal, SlidersHorizontal } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { useMyWorkers } from './MyWorkerControls';
import { SetupCard, useComputers } from './ComputerSetup';

const PROVIDERS: Provider[] = ['claude', 'codex'];
const providerName = (p: Provider) => p === 'codex' ? 'Codex' : 'Claude Code';

// The one way to add an agent: every Add agent button opens this dialog. openRequest opens it from elsewhere
// (the project header, the sidebar, the steer bar). The request ID and exact payload stay
// fixed through uncertain replies and modal closes.
export function AddAgent({ user, projectId, projectName, refresh, go, occupied = [], onOpenChange, icon = false, openRequest }: { user: SessionUser; projectId: string; projectName: string; refresh: () => void; go?: (route: Route) => void; occupied?: string[]; onOpenChange?: (open: boolean) => void; icon?: boolean; openRequest?: number }) {
  const storageKey = `mlswarm:web-agent-start:${user.uid}:${projectId}`;
  const [saved] = useState(() => { try { return readSavedStart(sessionStorage.getItem(storageKey), projectId); } catch { return null; } });
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  // Setup shows until the person clicks Continue, so the window never moves on by itself (owner, 21 October 2026).
  const [setupPhase, setSetupPhase] = useState<'unknown' | 'needed' | 'done'>('unknown');
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profileError, setProfileError] = useState(false);
  const [profileRetry, setProfileRetry] = useState(0);
  const { computers, error: computersError } = useComputers(user, open, tick);
  const [connectionId, setConnectionId] = useState(saved?.connectionId ?? '');
  const [provider, setProvider] = useState<Provider | null>(saved?.execution.provider ?? null);
  const [model] = useState(saved?.execution.model ?? '');
  const [name, setName] = useState(() => saved?.name ?? suggestAgentName(userPrefix(user.displayName), occupied));
  const [scope] = useState(saved?.scope ?? '');
  const [payload, setPayload] = useState<StartPayload | null>(saved);
  const [request, setRequest] = useState<StartRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const submitted = useRef<StartPayload | null>(saved);
  const computer = computers?.find(c => c.id === connectionId) ?? (connectionId ? undefined : computers?.[0]);
  // An offline computer takes the start when it comes online, so either coding agent may be chosen for it.
  const online = computerOnline(computer);
  const providers = online ? availableProviders(computer) : PROVIDERS;
  const chosenProvider = provider ?? providers[0];
  const ready = session.currentUid() === user.uid && !!profileId && !!computer && !!chosenProvider && providers.includes(chosenProvider) && !computersError;
  useEffect(() => {
    setProfileId(null); setProfileError(false);
    if (!open || session.currentUid() !== user.uid) return;
    let current = true;
    owner<{ profileId: string }>(user, '/profile').then(account => { if (current && session.currentUid() === user.uid) setProfileId(account.profileId); }, () => { if (current) setProfileError(true); });
    return () => { current = false; };
  }, [user.uid, open, profileRetry]);
  useEffect(() => { if (profileError) setProfileRetry(t => t + 1); }, [tick]);
  useEffect(() => { if (provider === null && providers.length) setProvider(providers[0]); }, [provider, providers.join(',')]);
  useEffect(() => { if (!open) return; const timer = setInterval(() => setTick(t => t + 1), setupPhase === 'needed' ? 4000 : 15000); return () => clearInterval(timer); }, [open, setupPhase]);
  useEffect(() => { if (!open) { setSetupPhase('unknown'); return; } if (setupPhase === 'unknown' && computers) setSetupPhase(computers.length === 0 ? 'needed' : 'done'); }, [open, computers, setupPhase]);
  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);
  useEffect(() => { onOpenChange?.(open); if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open, onOpenChange]);
  useEffect(() => () => { dialog.current?.close(); }, [user.uid, projectId]);
  useEffect(() => {
    if (!open || !profileId || !payload || (request && terminalStart(request))) return;
    let cancelled = false;
    async function poll() {
      try { const data = await ownOwner<{ request: StartRequest }>(user, profileId!, `/web-agent-starts/${payload!.id}`); if (!cancelled) { setRequest(data.request); setError(null); } }
      catch { /* An uncertain response retains its original request and retry path. */ }
    }
    void poll(); const timer = setInterval(() => void poll(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [user, profileId, open, payload, request?.state]);
  // A started or queued agent turns the dialog into a success message and forgets the request, so the next +
  // opens a fresh form. Failures stay in the dialog with Try again.
  const [added, setAdded] = useState<{ name: string; agentId?: string; waitingFor?: 'project' | 'time' | 'computer' | 'github'; viaPrompt?: boolean } | null>(null);
  const promptOpen = false;
  useEffect(() => { if (!open) setAdded(null); }, [open]);
  const settled = useRef<string | null>(null);
  // A request saved in this tab is picked up again only while it is still on its way; an old outcome is not news.
  const resumed = useRef(!!saved);
  useEffect(() => {
    if (!request || !payload || settled.current === request.id) return;
    if (resumed.current) { resumed.current = false; if (!['pending', 'accepted', 'starting'].includes(request.state)) { settled.current = request.id; newRequest(); return; } }
    const queued = request.state === 'pending' && (request.waitingFor === 'project' || request.waitingFor === 'time' || request.waitingFor === 'computer' || request.waitingFor === 'github');
    if (request.state !== 'working' && !queued) return;
    settled.current = request.id;
    refresh();
    setAdded({ name: payload.name, agentId: request.agentId ?? undefined, waitingFor: request.state === 'working' ? undefined : request.waitingFor as 'project' | 'time' | 'computer' | 'github' });
    newRequest();
  }, [request, payload]);
  // Added from the coding agent: the website only learns of it when a new agent with this name appears in My agents,
  // so while the prompt is open My agents is checked every 5 seconds.
  const workers = useMyWorkers();
  const watching = open && promptOpen && !added;
  const before = useRef<Set<string> | null>(null);
  useEffect(() => {
    before.current = watching ? new Set(workers?.data?.agents.map(a => a.agentId)) : null;
    if (!watching) return;
    const timer = setInterval(() => workers?.refresh(), 5000);
    return () => clearInterval(timer);
  }, [watching]);
  useEffect(() => {
    const agent = before.current && workers?.data?.agents.find(a => a.agentName === name && !before.current!.has(a.agentId));
    if (watching && agent) { refresh(); setAdded({ name, agentId: agent.agentId, viaPrompt: true }); newRequest(); }
  }, [workers?.data, watching, name]);
  async function send() {
    if (session.currentUid() !== user.uid || !profileId || busy || (request && terminalStart(request))) return;
    const original = submitted.current;
    if (!original && (!ready || !validAgentModel(model) || !/^[\w-]{1,64}$/.test(name) || !validAgentGoal(scope))) return;
    const next: StartPayload = original ?? { id: crypto.randomUUID(), connectionId: computer!.id, projectId, name, ...(scope.trim() ? { scope: scope.trim() } : {}), execution: { provider: chosenProvider!, model: model.trim() || null }, approved: true };
    submitted.current = next; try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Retained in memory when storage is unavailable. */ } setPayload(next); setBusy(true); setError(null);
    try { const data = await Promise.race([ownOwner<{ request: StartRequest }>(user, profileId!, '/web-agent-starts', next), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Unconfirmed response')), 15_000))]); setRequest(data.request); }
    catch (failure) {
      setError('The response could not be confirmed. Check this same request again; it will not create another agent.');
      if (failure instanceof ApiError && [400, 401, 403, 409].includes(failure.status)) {
        try { const result = await ownOwner<{ request: StartRequest }>(user, profileId!, `/web-agent-starts/${next.id}`); setRequest(result.request); }
        catch (check) { if (check instanceof ApiError && check.status === 404) { setRejected(true); setError(`${failure.message} No request was saved; edit this request to try again.`); } }
      }
    }
    finally { setBusy(false); }
  }
  const fixed = !!payload;
  function newRequest(another = true) { setRejected(false); try { sessionStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ } submitted.current = null; setPayload(null); setRequest(null); setError(null); if (another) setName(suggestAgentName(userPrefix(user.displayName), [...occupied, name])); }
  if (session.currentUid() !== user.uid) return null;
  return <>
    <Button className="primary" type="button" aria-label={icon ? 'Add agent' : undefined} title={icon ? 'Add agent' : undefined} onClick={() => setOpen(true)}>{icon ? <Plus size={22} aria-hidden="true" /> : 'Add agent'}</Button>
    {createPortal(<Dialog ref={dialog} className="agent-connect-dialog is-add-agent" aria-labelledby={`${id}-title`} onClose={() => setOpen(false)}>
      <div className="k42-contrib-body">
      <div className="agent-connections-heading"><h2 id={`${id}-title`}>Add agent to {projectName}</h2><CloseButton onClick={() => setOpen(false)} /></div>
      {added ? <div role="status" className="k42-add-done">
        <div className="k42-add-done-card"><span className="k42-add-done-avatar"><AgentAvatar name={added.name} id={added.agentId ?? added.name} ownerId={profileId} size={52} decorative /><span className="k42-add-check" aria-hidden="true"><Check size={12} /></span></span>
          <div><strong>{added.name} joined {projectName}</strong><p className="muted">{added.waitingFor === 'project' ? 'Starts when the owner starts the project' : added.waitingFor === 'time' ? 'Starts when the project has more time' : added.waitingFor === 'computer' ? 'Starts when your computer is online' : added.waitingFor === 'github' ? 'Starts once you have access to the project’s GitHub' : added.viaPrompt ? 'Working with you in your coding agent' : 'Working on the project goal'}</p></div></div>
        <ul className="k42-add-next">
          <li><Eye size={16} aria-hidden="true" /><div><strong>Watch it on Home</strong><p className="muted">It appears in the agents map with the others.</p></div></li>
          <li><SendHorizontal size={16} aria-hidden="true" /><div><strong>Steer it anytime</strong><p className="muted">Write under the map: “Tell your agents what to focus on…”</p></div></li>
          <li><SlidersHorizontal size={16} aria-hidden="true" /><div><strong>Change it later</strong><p className="muted">Persona and limits are on its page.</p></div></li>
        </ul>
        <div className="actions k42-add-footer"><Button type="button" className="k42-ph-thin" onClick={() => setAdded(null)}>Add another</Button>{added.agentId && go ? <Button type="button" className="primary k42-add-primary" onClick={() => { setOpen(false); go(projectRoute(projectId, 'agents', added.agentId!)); }}>View agent</Button> : <Button type="button" className="primary k42-add-primary" onClick={() => setOpen(false)}>Done</Button>}</div>
      </div> : <>
      {!fixed && setupPhase === 'needed' && <SetupCard connected={!!computers?.length} onCancel={() => setOpen(false)} onContinue={() => setSetupPhase('done')} />}
      <form hidden={!fixed && (setupPhase !== 'done' || !computers?.length)} onSubmit={e => { e.preventDefault(); void send(); }}>
        <fieldset disabled={fixed || busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <p className="k42-add-connected"><span className="k42-add-check" aria-hidden="true"><Check size={14} /></span>Computer connected<span className="muted">{providerName(chosenProvider!)} on {computer?.clientName ?? 'this computer'}</span></p>
          <p className="muted k42-add-note">It works toward the project goal. You can steer it anytime.</p>
          {!!computers && computers.length > 1 && <><p className="k42-add-label" id={`${id}-computer`}>Computer</p>
            <div className="k42-contrib-chips" role="group" aria-labelledby={`${id}-computer`}>{computers.map(c => <Button key={c.id} type="button" className="k42-contrib-chip" aria-pressed={computer?.id === c.id} onClick={() => { setConnectionId(c.id); setProvider(null); }}>{c.clientName}{computerOnline(c) ? '' : ' · offline'}</Button>)}</div></>}
          {providers.length > 1 && <>
          <p className="k42-add-label" id={`${id}-provider`}>Runs on your computer with</p>
          <div className="k42-contrib-chips" role="group" aria-labelledby={`${id}-provider`}>{PROVIDERS.map(p => <Button key={p} type="button" className="k42-contrib-chip" aria-pressed={chosenProvider === p} disabled={!providers.includes(p)} title={providers.includes(p) ? undefined : `${providerName(p)} isn’t set up on ${computer?.clientName ?? 'your computer'}`} onClick={() => setProvider(p)}><span className={`k42-contrib-mark k42-tone-${p === 'claude' ? 'butter' : 'mint'}`} aria-hidden="true">{p === 'claude' ? 'C' : 'X'}</span>{providerName(p)}</Button>)}</div>
          </>}
        </fieldset>
        {!fixed && <>
          {profileError ? <p className="error" role="alert">Could not verify your account. Trying again…</p>
            : computersError ? <p className="error" role="alert">Could not reach your computer. Trying again…</p>
            : !profileId || computers === null ? <p className="muted" role="status">Getting ready…</p>
            : computer && !online ? <p role="status">{computer.clientName} is offline. The agent starts when it’s online.</p>
            : !ready && <p role="status">Claude Code and Codex aren’t ready on {computer?.clientName ?? 'your computer'}. Open your coding agent there and ask it to update MyLittleSwarm. This updates by itself.</p>}
          <div className="actions k42-add-footer"><Button type="button" className="soft" onClick={() => setOpen(false)}>Cancel</Button><Button className="primary k42-add-primary" type="submit" disabled={!ready || busy || !validAgentModel(model) || !validAgentGoal(scope)}><Bot size={18} aria-hidden="true" />Add agent</Button></div></>}
        {fixed && <><p role="status">{rejected ? 'This request was not accepted.' : request ? startMessage(request) : 'Starting… Checking whether your computer accepted this request.'}</p>
          {request?.agentId && go && <p><NavLink to={projectRoute(projectId, 'agents', request.agentId)} go={route => { setOpen(false); go(route); }}>Open {payload.name}</NavLink></p>}
          {rejected ? <Button type="button" onClick={() => newRequest(false)}>Edit request</Button> : request && terminalStart(request) ? request.state !== 'recovery_required' && <Button type="button" onClick={() => newRequest(false)}>Try again</Button> : <Button type="button" disabled={busy} onClick={() => void send()}>{busy ? 'Checking…' : 'Check same request again'}</Button>}
        </>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
      </>}
      </div>
    </Dialog>, document.body)}
  </>;
}
