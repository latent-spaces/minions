import { useEffect, useId, useState } from 'react';
import { Copy, Check, MessageSquare, Pencil } from 'lucide-react';
import { claudePrompt, DEFAULT_PROMPT_CHOICES, MAX_PROMPT_AGENTS, type PromptChoices } from './claude-prompt';
import { EmptyState } from './EmptyState';
import './segments.css';
import './add-tile.css';

// Projects are created from a coding agent, not from this app (owner, 10 November 2026). This prompt shows how.

/** Copies a prompt; `copied` is true for two seconds after a copy. */
function useCopyPrompt(prompt: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  const copy = () => { void navigator.clipboard.writeText(prompt).then(() => setCopied(true), () => undefined); };
  return { copied, copy };
}

/** The start prompt with Copy and Edit; Edit opens the choices: a private or public repository, how many agents, and what
 * to build (owner, 11 November 2026). First in My projects it is a dashed tile with a project card's footprint; with no
 * projects yet it is the large lilac empty state, with the same prompt and choices (owner, 12 November 2026). */
export function ClaudePromptTile({ large = false }: { large?: boolean }) {
  const [choices, setChoices] = useState<PromptChoices>(DEFAULT_PROMPT_CHOICES);
  const [editing, setEditing] = useState(false);
  const prompt = claudePrompt(choices);
  const { copied, copy } = useCopyPrompt(prompt);
  const id = useId();
  const set = (next: Partial<PromptChoices>) => setChoices(previous => ({ ...previous, ...next }));
  const toggle = () => setEditing(open => !open);
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
  if (large) return <EmptyState icon={MessageSquare} size="large" title="Start your first project from your coding agent"
    action={<span className="k42-add-tile-actions">
      <button type="button" className="primary" onClick={copy}>{copied ? 'Copied' : 'Copy the prompt'}</button>
      <button type="button" aria-expanded={editing} onClick={toggle}>{editing ? 'Done' : 'Edit the prompt'}</button>
    </span>}>
    <span aria-live="polite">Ask your coding agent, for example: “{prompt}”</span>
    {editor}
  </EmptyState>;
  return <div className={`k42-add-tile${editing ? ' is-editing' : ''}`}>
    <span className="k42-add-tile-icon" aria-hidden="true"><MessageSquare size={22} strokeWidth={1.75} /></span>
    <span className="k42-add-tile-title">Start a project from your coding agent</span>
    <span className="k42-add-tile-prompt" aria-live="polite">“{prompt}”</span>
    {editor}
    <span className="k42-add-tile-actions">
      <button type="button" className="k42-add-tile-text" onClick={copy}>{copied ? <><Check size={14} aria-hidden="true" /> Copied</> : <><Copy size={14} aria-hidden="true" /> Copy the prompt</>}</button>
      <button type="button" className="k42-add-tile-text" aria-expanded={editing} onClick={toggle}>{editing ? <><Check size={14} aria-hidden="true" /> Done</> : <><Pencil size={14} aria-hidden="true" /> Edit the prompt</>}</button>
    </span>
  </div>;
}
