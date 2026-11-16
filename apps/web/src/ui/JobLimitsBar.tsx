import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Workspace } from '../project-api';
import { Button } from './Button';
import type { ProjectControls } from './ProjectControls';
import { Plus } from './icons';
import { formatTokens, jobTimeLine, jobTokensUsed, parseTokenCap, tidyTokenCap } from './job-limits';
import './job-limits.css';

/**
 * The job bar above the Agents cards (decision 10 November 2026: concept 1 with concept 2's exact-number cap editor). The
 * owner sees when the job ends and adds 30 minutes with one click (owner, 12 November 2026), and sees, sets, changes or removes the job's token cap: one pool for
 * all their agents in the project. Shown once the job has started; a closed project changes nothing.
 */
export function JobLimitsBar({ workspace, controls }: { workspace: Workspace; controls: ProjectControls }) {
  const id = useId();
  const [editing, setEditing] = useState(false), [saved, setSaved] = useState('');
  const opener = useRef<HTMLButtonElement>(null), returnFocus = useRef(false);
  useEffect(() => { if (!editing && returnFocus.current) { returnFocus.current = false; opener.current?.focus(); } }, [editing]);
  if (workspace.role !== 'owner' || !workspace.project?.started || workspace.execution === 'closed') return null;
  const { data, now } = controls.workers;
  const cap = workspace.tokenLimit?.tokens ?? null, used = Math.max(workspace.tokensUsed ?? 0, jobTokensUsed(data?.agents ?? []));
  const reached = cap !== null && used >= cap, timeUp = (workspace.endsAt ?? 0) <= now;
  const locked = controls.locked;
  const close = () => { returnFocus.current = true; setEditing(false); };
  const save = async (tokens: number | null) => {
    if (!await controls.setTokens(tokens)) return;
    setSaved(tokens === null ? 'Token cap removed.' : 'Token cap saved.');
    close();
  };
  // One row, short words (owner, 12 November 2026); the longer explanations are in each value's hover text.
  return <section className="k42-job-bar" aria-labelledby={`${id}-title`}>
    <h5 id={`${id}-title`} className="visually-hidden">This job</h5>
    <div className="k42-job-parts">
      <div className="k42-job-part">
        <span className="k42-job-label">Time</span>
        <span className={timeUp ? 'k42-job-value is-alert' : 'k42-job-value'} title={timeUp ? 'Agents finish their turn, then wait for more time.' : undefined}>{jobTimeLine(workspace.endsAt ?? null, now)}</span>
        <Button type="button" disabled={locked} aria-label="Add 30 minutes" title="Moves the end time for every agent in this project. Only the owner can do this."
          onClick={() => void controls.act('add_time', 30)}><Plus size={14} aria-hidden="true" />30 min</Button>
      </div>
      <div className="k42-job-part">
        <span className="k42-job-label">Tokens</span>
        {!editing && <><span className={reached ? 'k42-job-value is-alert' : 'k42-job-value'} title={reached ? 'Cap reached. Agents wait after their current turn until you raise or remove it.' : undefined}>
          {cap === null ? 'No cap' : `${formatTokens(used)} of ${formatTokens(cap)}`}</span>
        {cap !== null && <span className={`k42-job-meter${reached ? ' is-full' : ''}`} aria-hidden="true"><span style={{ width: `${Math.min(100, used / cap * 100)}%` }} /></span>}</>}
        {!editing && <Button ref={opener} type="button" disabled={locked} onClick={() => { setSaved(''); setEditing(true); }}>{cap === null ? 'Set cap' : 'Change cap'}</Button>}
        {/* The cap is edited in place, in this row (owner, 16 November 2026). */}
        {editing && <TokenCapEditor id={`${id}-cap`} initial={cap === null ? '' : formatTokens(cap)} cap={cap} used={used} locked={locked} busy={controls.busy}
      failed={!controls.busy && !!controls.error} onSave={tokens => void save(tokens)} onRemove={() => void save(null)} onCancel={close} />}
      </div>
    </div>
    <small role="status" className="k42-job-saved">{saved}</small>
  </section>;
}

/** The exact-number cap editor: a plain whole number, shown with thousands separators. */
export function TokenCapEditor({ id, initial, cap, used, locked, busy, failed, onSave, onRemove, onCancel }: { id: string; initial: string; cap: number | null; used: number; locked: boolean; busy: boolean; failed: boolean;
  onSave: (tokens: number) => void; onRemove: () => void; onCancel: () => void }) {
  const [text, setText] = useState(initial), [submitted, setSubmitted] = useState(false), [tried, setTried] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const parsed = parseTokenCap(text);
  // An empty field is named only on Save; anything else that is not a whole number is named as it is typed.
  const error = parsed.error && (submitted || text.trim() !== '') ? parsed.error : null;
  const below = parsed.tokens !== null && parsed.tokens <= used;
  const submit = (event: FormEvent) => {
    event.preventDefault(); setSubmitted(true);
    if (parsed.tokens === null) { input.current?.focus(); return; }
    if (parsed.tokens === cap) { onCancel(); return; }
    setTried(true); onSave(parsed.tokens);
  };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } };
  const described = [`${id}-help`, error ? `${id}-error` : '', below ? `${id}-below` : ''].filter(Boolean).join(' ');
  return <form className="k42-cap-editor is-inline" onSubmit={submit} onKeyDown={escape} noValidate>
    <label htmlFor={id} className="visually-hidden">Token cap</label>
    <input ref={input} id={id} type="text" inputMode="numeric" autoComplete="off" spellCheck={false} value={text} aria-invalid={!!error} aria-describedby={described}
      title="One pool for all your agents in this project. Input, cache writes and output count; cache reads don’t." placeholder="e.g. 500,000"
      onChange={event => setText(event.target.value)} onBlur={() => setText(tidyTokenCap(text))} />
    <span className="muted">tokens</span>
    <Button type="submit" className="primary" disabled={locked} aria-busy={busy}>{busy ? 'Saving…' : 'Save'}</Button>
    <Button type="button" className="k42-cap-text" onClick={onCancel}>Cancel</Button>
    {cap !== null && <Button type="button" className="k42-cap-text" disabled={locked} onClick={() => { setTried(true); onRemove(); }}>Remove cap</Button>}
    <small id={`${id}-help`} className="visually-hidden">One pool for all your agents in this project. Input, cache writes and output count; cache reads don’t.</small>
    {error && <small id={`${id}-error`} className="error k42-cap-note">{error}</small>}
    {below && !error && <small id={`${id}-below`} className="k42-cap-note">Your agents have used {formatTokens(used)} tokens. With this cap they wait after their current turn until you raise or remove it.</small>}
    {tried && failed && <small className="error k42-cap-note">Not saved. Try again, or check the message above.</small>}
  </form>;
}
