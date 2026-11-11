import { useEffect, useId, useState } from 'react';
import { Copy, Check, MessageSquare, Pencil } from 'lucide-react';
import { claudePrompt, DEFAULT_PROMPT_CHOICES, MAX_PROMPT_AGENTS, type PromptChoices } from './claude-prompt';
import './segments.css';
import './add-tile.css';

// Projects are created from Claude, not from this app (owner, 10 November 2026). This prompt shows how.
export const CLAUDE_EXAMPLE_PROMPT = claudePrompt(DEFAULT_PROMPT_CHOICES);

/** Copies a prompt; `copied` is true for two seconds after a copy. */
export function useCopyPrompt(prompt = CLAUDE_EXAMPLE_PROMPT) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  const copy = () => { void navigator.clipboard.writeText(prompt).then(() => setCopied(true), () => undefined); };
  return { copied, copy };
}

/** The dashed tile with a project card's footprint, first in My projects: the prompt, with Copy and Edit beside each other.
 * Edit opens the choices in the tile: a private or public repository, how many agents, and what to build (owner, 11 November 2026). */
export function ClaudePromptTile() {
  const [choices, setChoices] = useState<PromptChoices>(DEFAULT_PROMPT_CHOICES);
  const [editing, setEditing] = useState(false);
  const prompt = claudePrompt(choices);
  const { copied, copy } = useCopyPrompt(prompt);
  const id = useId();
  const set = (next: Partial<PromptChoices>) => setChoices(previous => ({ ...previous, ...next }));
  return <div className={`k42-add-tile${editing ? ' is-editing' : ''}`}>
    <span className="k42-add-tile-icon" aria-hidden="true"><MessageSquare size={22} strokeWidth={1.75} /></span>
    <span className="k42-add-tile-title">Start a project from Claude</span>
    <span className="k42-add-tile-prompt" aria-live="polite">“{prompt}”</span>
    {editing && <div className="k42-prompt-editor">
      <div className="k42-task-segments" role="group" aria-label="GitHub repository">
        {(['private', 'public'] as const).map(value => <button key={value} type="button" className="k42-task-segment" aria-pressed={choices.visibility === value} onClick={() => set({ visibility: value })}>{value === 'private' ? 'Private' : 'Public'}</button>)}
      </div>
      <label htmlFor={`${id}-agents`}>Agents
        <input id={`${id}-agents`} type="number" min={1} max={MAX_PROMPT_AGENTS} value={choices.agents} onChange={event => set({ agents: Number(event.target.value) })} />
      </label>
      <label htmlFor={`${id}-goal`}>What to build
        <textarea id={`${id}-goal`} rows={2} maxLength={300} value={choices.goal} placeholder={DEFAULT_PROMPT_CHOICES.goal} onChange={event => set({ goal: event.target.value })} />
      </label>
    </div>}
    <span className="k42-add-tile-actions">
      <button type="button" className="k42-add-tile-text" onClick={copy}>{copied ? <><Check size={14} aria-hidden="true" /> Copied</> : <><Copy size={14} aria-hidden="true" /> Copy the prompt</>}</button>
      <button type="button" className="k42-add-tile-text" aria-expanded={editing} onClick={() => setEditing(open => !open)}>{editing ? <><Check size={14} aria-hidden="true" /> Done</> : <><Pencil size={14} aria-hidden="true" /> Edit the prompt</>}</button>
    </span>
  </div>;
}
