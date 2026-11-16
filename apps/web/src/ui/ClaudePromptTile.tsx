import { useEffect, useId, useState } from 'react';
import { Copy, Check, MessageSquare, Pencil } from 'lucide-react';
import { claudePrompt, DEFAULT_PROMPT_CHOICES, MAX_PROMPT_AGENTS, type PromptChoices } from './claude-prompt';
import { WelcomeTeam } from './WelcomeTeam';
import './segments.css';
import './add-tile.css';

// Projects are created from a coding agent, not from this app (owner, 10 November 2026). This prompt shows how.

const EXAMPLE_GOALS = ['a 2D game', 'a website for my studio', 'a deep research report on home batteries', 'a habit-tracker app', 'a Chrome extension that summarizes tabs'];
const GOAL_MARK = '\u0000';
const GOAL_LEAVE_MS = 280;

/** Copies a prompt; `copied` is true for two seconds after a copy. */
function useCopyPrompt(prompt: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  const copy = () => { void navigator.clipboard.writeText(prompt).then(() => setCopied(true), () => undefined); };
  return { copied, copy };
}

/** The welcome above My projects: the team, a heading and the start prompt with Copy and Edit; Edit opens the choices:
 * a private or public repository, how many agents, and what to build (owner, 11 November 2026). On the first run, with no
 * projects yet, it also says what Minions is and shows three steps (Concept A, owner 16 November 2026). */
export function ClaudePromptTile({ firstRun = false }: { firstRun?: boolean }) {
  const [choices, setChoices] = useState<PromptChoices>(DEFAULT_PROMPT_CHOICES);
  const [editing, setEditing] = useState(false);
  // On the welcome, the goal cycles through examples until the person edits or points at the prompt (owner, 16 November 2026).
  const [example, setExample] = useState(0), [leaving, setLeaving] = useState(false), [held, setHeld] = useState(false), [touched, setTouched] = useState(false);
  const cycling = !editing && !held && !touched;
  useEffect(() => {
    if (!cycling || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Every swap is the same: the goal leaves upward, then the next one rises from below.
    let swap: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => { setLeaving(true); swap = setTimeout(() => { setExample(n => (n + 1) % EXAMPLE_GOALS.length); setLeaving(false); }, GOAL_LEAVE_MS); }, 2800);
    return () => { clearInterval(timer); clearTimeout(swap); setLeaving(false); };
  }, [cycling]);
  const shown = !touched ? { ...choices, goal: EXAMPLE_GOALS[example] } : choices;
  const prompt = claudePrompt(shown);
  const [before, after] = claudePrompt({ ...shown, goal: GOAL_MARK }).split(GOAL_MARK);
  const { copied, copy } = useCopyPrompt(prompt);
  const id = useId();
  const set = (next: Partial<PromptChoices>) => setChoices(previous => ({ ...previous, ...next }));
  // Editing keeps the example on screen as the starting goal, and the cycling stops for good.
  const toggle = () => { if (!editing && !touched) { set({ goal: EXAMPLE_GOALS[example] }); setTouched(true); } setEditing(open => !open); };
  const editor = editing && <div className="k42-prompt-editor">
    <div className="k42-task-segments" role="group" aria-label="GitHub repository">
      {(['private', 'public'] as const).map(value => <button key={value} type="button" className="k42-task-segment" aria-pressed={choices.visibility === value} onClick={() => set({ visibility: value })}>{value === 'private' ? 'Private' : 'Public'}</button>)}
    </div>
    <label htmlFor={`${id}-agents`}>Agents
      <input id={`${id}-agents`} type="number" min={1} max={MAX_PROMPT_AGENTS} value={choices.agents} onChange={event => set({ agents: Number(event.target.value) })} />
    </label>
    <label htmlFor={`${id}-goal`}>What to build
      <textarea id={`${id}-goal`} rows={2} maxLength={300} value={choices.goal} placeholder={DEFAULT_PROMPT_CHOICES.goal} onChange={event => set({ goal: event.target.value })} />
    </label>
  </div>;
  return <section className="k42-welcome" aria-labelledby={`${id}-welcome`}>
    {firstRun && <span className="k42-welcome-bubble">Hi! Give us a goal and we’ll get to work.</span>}
    <WelcomeTeam />
    <h2 id={`${id}-welcome`}>Your own little swarm of coding agents</h2>
    {firstRun && <><p className="k42-welcome-lead">Give a project a goal, add a few Claude Code or Codex agents, and they work in the background on this computer. You follow along and answer when they need you.</p>
    <ol className="k42-welcome-steps">
      <li><h3>Ask your coding chat</h3><p>In Claude Code or Codex, ask for a Minions project for your repository.</p></li>
      <li><h3>Add agents</h3><p>Each one works in its own folder and talks to the others through the project.</p></li>
      <li><h3>Follow and steer</h3><p>Their progress shows up here. Pause or stop them whenever you choose.</p></li>
    </ol></>}
    <div className="k42-welcome-prompt" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <p className="k42-welcome-prompt-text" aria-live={cycling ? 'off' : 'polite'}>{before}<span key={shown.goal} className={`k42-welcome-goal${leaving ? ' is-leaving' : ''}`} data-tone={touched ? undefined : example % 5}>{shown.goal.trim().replace(/[.\s]+$/, '') || DEFAULT_PROMPT_CHOICES.goal}</span>{after}</p>
      <span className="k42-welcome-prompt-footer">
        <span className="k42-welcome-prompt-label"><MessageSquare size={14} aria-hidden="true" /> Paste into Claude Code or Codex</span>
        <button type="button" aria-expanded={editing} onClick={toggle}>{editing ? <><Check size={14} aria-hidden="true" /> Done</> : <><Pencil size={14} aria-hidden="true" /> Edit</>}</button>
        <button type="button" className="primary" onClick={copy}>{copied ? <><Check size={14} aria-hidden="true" /> Copied</> : <><Copy size={14} aria-hidden="true" /> Copy the prompt</>}</button>
      </span>
    </div>
    {editor}
  </section>;
}
