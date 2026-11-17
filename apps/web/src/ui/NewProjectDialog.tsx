import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Hourglass, X } from './icons';
import { WelcomeTeam } from './WelcomeTeam';
import { ToolMarks } from './ToolMarks';
import { Confetti } from './Confetti';
import './welcome.css';
import './first-project.css';

// The new-project popup (owner, 16 November 2026): an idea, how many agents, for how long and with what token cap, then
// the prompt to copy into a new Claude Code or Codex chat. After Copy it waits; when `created` arrives it celebrates and
// opens the project. Projects are created from a coding chat (owner, 10 November 2026), not from this app.
// Sensible defaults: 3 agents, 30 minutes, a 500,000-token cap shared by all of them (owner, 16 November 2026).
type Job = { agents: number; minutes: number; tokens: number | null };
const DEFAULT_JOB: Job = { agents: 3, minutes: 30, tokens: 500_000 };
const MINUTES = [15, 30, 60, 120], TOKENS: (number | null)[] = [250_000, 500_000, 1_000_000, 2_000_000, null];
const duration = (minutes: number) => minutes < 60 ? `${minutes} minutes` : minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
const tokenText = (tokens: number | null) => tokens === null ? 'No cap' : tokens >= 1_000_000 ? `${tokens / 1_000_000}M tokens` : `${tokens / 1000}k tokens`;
// It names the skill and Minions, so the coding agent loads the minions skill instead of guessing (from main, 16 November 2026).
const ideaPrompt = (idea: string, job: Job) => `Use the minions skill: create a Minions project in a new private GitHub repo, and add ${job.agents} Claude Sonnet ${job.agents === 1 ? 'agent' : 'agents'} for ${duration(job.minutes)}${job.tokens === null ? '' : ` with a ${job.tokens.toLocaleString('en-US')} token cap`} to build me ${idea.trim().replace(/[.\s]+$/, '') || 'a small web app'}.`;

export type Created = { id: string; name: string } | null;
export function NewProjectDialog({ open, onClose, created = null, onWaiting, onOpenProject }: { open: boolean; onClose: () => void; created?: Created; onWaiting?: (waiting: boolean) => void; onOpenProject?: (id: string) => void }) {
  const [idea, setIdea] = useState(''), [copied, setCopied] = useState(false), [job, setJob] = useState<Job>(DEFAULT_JOB);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  const prompt = ideaPrompt(idea, job);
  // After Copy the popup waits for the project, then celebrates it (owner, 16 November 2026).
  const [waiting, setWaiting] = useState(false), [slow, setSlow] = useState(false);
  useEffect(() => { onWaiting?.(waiting && !created); }, [waiting, created, onWaiting]);
  useEffect(() => { if (!waiting || created) return; setSlow(false); const timer = setTimeout(() => setSlow(true), 60_000); return () => clearTimeout(timer); }, [waiting, created]);
  // Once the project is here, it opens by itself after a short countdown (owner, 16 November 2026).
  const [left, setLeft] = useState(4);
  useEffect(() => { if (!created) return; setLeft(4); const timer = setInterval(() => setLeft(n => n - 1), 1000); return () => clearInterval(timer); }, [created]);
  useEffect(() => { if (created && left <= 0) onOpenProject?.(created.id); }, [created, left, onOpenProject]);
  // Only a host that passes onOpenProject (the first-run flow) watches for the project, so only it may say it is waiting.
  const watching = onOpenProject !== undefined;
  const close = () => { setWaiting(false); onClose(); };
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = dialog.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  const copy = () => { void navigator.clipboard.writeText(prompt).then(() => { setCopied(true); setWaiting(true); }, () => undefined); };
  return <dialog ref={dialog} className="k42-first-dialog" aria-labelledby="k42-first-step-title" onClose={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="k42-first is-step">
    <button type="button" className="k42-first-close" aria-label="Close" onClick={close}><X size={18} aria-hidden="true" /></button>
    {created ? <div className="k42-first-ready">
      <Confetti />
      <WelcomeTeam />
      <h2 id="k42-first-step-title">Your project is here!</h2>
      <p><strong>{created.name}</strong> was created. Open it to watch your agents start.</p>
      <button type="button" className="primary k42-first-open" onClick={() => onOpenProject?.(created.id)}>Open project<ArrowRight size={16} aria-hidden="true" /></button>
      <small className="k42-first-countdown" aria-live="polite">Opening in {Math.max(0, left)}…</small>
    </div> : waiting ? <div className="k42-first-waiting">
      <h2 id="k42-first-step-title">Now paste it in your chat</h2>
      <ol className="k42-first-checklist">
        <li className="is-done"><Check size={14} aria-hidden="true" />Prompt copied</li>
        <li className="is-now"><Hourglass size={14} aria-hidden="true" />Paste it in a <strong>new</strong> Claude Code or Codex chat</li>
        <li><Hourglass size={14} aria-hidden="true" />Say yes when it asks to create the project</li>
      </ol>
      {watching ? <p className="k42-first-wait" role="status"><span className="k42-first-dots" aria-hidden="true"><i /><i /><i /></span>Waiting for your project…</p>
        : <p className="k42-first-wait">It shows up under Projects once your chat creates it.</p>}
      {watching && slow && <div className="k42-first-slow"><strong>Nothing yet?</strong> Make sure the chat was opened after you installed Minions, then paste again.
        <button type="button" onClick={copy}><Copy size={14} aria-hidden="true" />Copy again</button></div>}
      <div className="k42-first-wait-actions">
        <button type="button" className="k42-first-edit" onClick={() => setWaiting(false)}>Change the prompt</button>
        {!watching && <button type="button" className="primary" onClick={close}>Done</button>}
      </div>
    </div> : <>
    <h2 id="k42-first-step-title">Describe it, then hand it to your chat</h2>
    {/* An abstract picture of the hand-off: the prompt travels from Minions to a Claude Code or Codex chat (owner, 16 November 2026). */}
    <div className="k42-handoff" aria-hidden="true">
      <span className="k42-handoff-node"><span className="k42-handoff-mark" /><small>Minions</small></span>
      <span className="k42-handoff-wire"><span className="k42-handoff-packet"><Copy size={12} /></span></span>
      <span className="k42-handoff-node is-chat"><span className="k42-handoff-window"><i /><i /><i /><b>&gt;_</b></span><small><ToolMarks size={13} /> Claude Code · Codex</small></span>
    </div>
    <label className="k42-first-idea"><span>What should they build?</span>
      <input value={idea} maxLength={300} placeholder="a recipe app with a weekly meal planner" onChange={event => setIdea(event.target.value)} autoFocus /></label>
    <div className="k42-first-job">
      <label><span>Agents</span><select value={job.agents} onChange={event => setJob(j => ({ ...j, agents: Number(event.target.value) }))}>{[1, 2, 3, 4, 5, 6, 8, 10].map(n => <option key={n} value={n}>{n} {n === 1 ? 'agent' : 'agents'}</option>)}</select></label>
      <label><span>Time</span><select value={job.minutes} onChange={event => setJob(j => ({ ...j, minutes: Number(event.target.value) }))}>{MINUTES.map(m => <option key={m} value={m}>{duration(m)}</option>)}</select></label>
      <label><span>Token cap</span><select value={job.tokens ?? 'none'} onChange={event => setJob(j => ({ ...j, tokens: event.target.value === 'none' ? null : Number(event.target.value) }))}>{TOKENS.map(t => <option key={t ?? 'none'} value={t ?? 'none'}>{tokenText(t)}</option>)}</select></label>
    </div>
    <div className="k42-welcome-prompt">
      <p className="k42-welcome-prompt-text" aria-live="polite">{prompt}</p>
      <span className="k42-welcome-prompt-footer">
        <span className="k42-composer-chip"><ToolMarks />Claude Code · Codex</span>
        <button type="button" className="k42-composer-send" onClick={copy} aria-label={copied ? 'Copied' : 'Copy the prompt'} title={copied ? 'Copied' : 'Copy the prompt'}>{copied ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}</button>
      </span>
    </div>
    <ol className="k42-first-steps">
      <li><b>1</b>Copy the prompt</li>
      <li><b>2</b>Open a new Claude Code or Codex chat</li>
      <li><b>3</b>Paste it and say yes. Your project shows up here.</li>
    </ol></>}
      </div>
    </dialog>;
}
