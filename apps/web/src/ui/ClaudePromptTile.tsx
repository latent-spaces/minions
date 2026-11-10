import { useEffect, useState } from 'react';
import { Copy, Check, MessageSquare } from 'lucide-react';
import './add-tile.css';

// Projects are created from Claude, not from this app (owner, 10 November 2026). This prompt shows how.
export const CLAUDE_EXAMPLE_PROMPT = 'Open a private GitHub repo and add 3 Claude Sonnet agents for 5 minutes to build me a 2D game.';

/** Copies the example prompt; `copied` is true for two seconds after a copy. */
export function useCopyPrompt() {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  const copy = () => { void navigator.clipboard.writeText(CLAUDE_EXAMPLE_PROMPT).then(() => setCopied(true), () => undefined); };
  return { copied, copy };
}

/** The dashed tile with a project card's footprint, first in My projects: the example prompt, copied on click. */
export function ClaudePromptTile() {
  const { copied, copy } = useCopyPrompt();
  return <button type="button" className="k42-add-tile" onClick={copy}>
    <span className="k42-add-tile-icon" aria-hidden="true"><MessageSquare size={22} strokeWidth={1.75} /></span>
    <span className="k42-add-tile-title">Start a project from Claude</span>
    <span className="k42-add-tile-prompt">“{CLAUDE_EXAMPLE_PROMPT}”</span>
    <span className="k42-add-tile-text" aria-live="polite">{copied ? <><Check size={14} aria-hidden="true" /> Copied</> : <><Copy size={14} aria-hidden="true" /> Copy the prompt</>}</span>
  </button>;
}
