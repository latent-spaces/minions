import { Button } from './Button';
import type { SessionUser } from '../session-identity';
import { useEffect, useMemo, useState, useRef } from 'react';
import { owner } from '../api';
import { CHECKOUT, CHECKOUT_PREPARE, computerSetupInstructions, GITHUB_COMMANDS, githubSetupInstructions, setupCommand } from '../setup-instruction';
import './your-agent.css';
import { Check, Copy } from 'lucide-react';
import './first-ai.css';

export type Computer = { id: string, clientName: string, approvedAt: number; runtime?: null | { protocol: number; version: string; incarnation: string; platform: string; providers: { id: string; available: boolean; reason: string }[]; lastSeenAt: number; online: boolean } };
// A page that is not focused may never settle a clipboard write; the prompt is then shown to copy by hand.
export async function copyText(text: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.clipboard.writeText(text).then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1500); }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Setup connects this computer by itself, so the list is all of this owner's connected computers.
export function useComputers(user: SessionUser, active: boolean, tick: number) {
  const [state, setState] = useState<{ computers: Computer[] | null, error: string | null }>({ computers: null, error: null });
  const [lookedAt, setLookedAt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const read = async () => {
      const computers: Computer[] = [];
      let next: string | null = null;
      do {
        const page: { computers: Computer[]; next: string | null } = await owner(user, `/computers${next ? `?${new URLSearchParams({ cursor: next })}` : ''}`);
        if (cancelled) return;
        computers.push(...page.computers); next = page.next;
      } while (next);
      setState({ computers: computers.sort((a, b) => b.approvedAt - a.approvedAt), error: null });
    };
    void read().catch((e: Error) => { if (!cancelled) setState(s => ({ computers: s.computers, error: e.message })); });
    return () => { cancelled = true; };
  }, [user, active, tick, lookedAt]);
  // While no computer is set up or online, look again every 2 seconds (for up to 2 minutes), so a computer
  // that just finished setup appears without waiting for the regular check.
  const waiting = active && !!state.computers && !state.computers.some(c => c.runtime?.online);
  const fastChecks = useRef(0);
  useEffect(() => { if (!waiting) fastChecks.current = 0; }, [waiting]);
  useEffect(() => {
    if (!waiting || fastChecks.current >= 60) return;
    const timer = setTimeout(() => { fastChecks.current++; setLookedAt(Date.now()); }, 2000);
    return () => clearTimeout(timer);
  }, [waiting, state]);
  return state;
}

// The one copy implementation for a prompt behind a button.
export function CopyPromptButton({ prompt, className = 'primary', label = 'Copy prompt' }: { prompt: string, className?: string, label?: string }) {
  const [copied, setCopied] = useState<{ prompt: string, ok: boolean } | null>(null);
  const done = copied?.prompt === prompt ? copied.ok : null;
  return <><Button className={className} type="button" aria-label={done === null ? label : done ? 'Copied' : 'Select and copy'} onClick={() => void copyText(prompt).then(ok => setCopied({ prompt, ok }))}><Copy size={18} aria-hidden="true" /><span role="status">{done === null ? label : done ? 'Copied' : 'Select and copy'}</span></Button>{done === false && <textarea aria-label={label} readOnly rows={4} value={prompt} onFocus={event => event.target.select()} />}</>;
}

// A command for people who use a terminal, one line per step, as a box with a small copy button at its end.
export function CopyCommand({ command, label = 'Copy command' }: { command: string, label?: string }) {
  const [result, setResult] = useState<{ command: string; ok: boolean } | null>(null);
  const copied = result?.command === command ? result.ok : null;
  return <div className="agent-command">
    <pre className="agent-command-text"><code>{command}</code></pre>
    <Button className="soft" type="button" aria-label={label} onClick={() => void copyText(command).then(ok => setResult({ command, ok }))}><Copy size={14} aria-hidden="true" />Copy</Button>
    <span className="agent-command-status" role="status">{copied === true ? 'Copied' : copied === false ? 'Could not copy. Select the text and copy it manually.' : ''}</span>
  </div>;
}
// A prompt for the coding agent, always in view, with the one button that copies it.
export function PromptBox({ prompt, label, rows = 2 }: { prompt: string, label: string, rows?: number }) {
  return <div className="agent-command">
    <textarea aria-label={label} readOnly rows={rows} value={prompt} onFocus={event => event.target.select()} />
    <CopyPromptButton prompt={prompt} />
  </div>;
}
const setupPrompt = () => computerSetupInstructions(window.location.origin);
// Every Connect your X reads the same: the commands, or the prompt for the coding agent.
function ConnectSteps({ intro, command, commandLabel, then, prompt, promptLabel }: { intro: string; command: string; commandLabel: string; then?: string; prompt: string; promptLabel: string }) {
  return <>
    <p className="muted">{intro}</p>
    <CopyCommand command={command} label={commandLabel} />
    <h3>Or let your coding agent do it</h3>
    <p className="muted">Paste this into your coding chat{then ? `, then ${then} in the browser` : ''}.</p>
    <CopyCommand command={prompt} label={promptLabel} />
  </>;
}
export function SetupSteps() {
  const prompt = useMemo(setupPrompt, []), command = useMemo(() => setupCommand(window.location.origin), []);
  return <ConnectSteps intro={`In ${CHECKOUT}, run ${CHECKOUT_PREPARE}, then run this in your terminal. It connects this computer, your coding agents and GitHub.`} command={command} commandLabel="Copy setup command" prompt={prompt} promptLabel="Copy setup prompt" />;
}
export function GitHubSteps() {
  return <ConnectSteps intro="Run these in your terminal:" command={GITHUB_COMMANDS.join('\n')} commandLabel="Copy GitHub commands" then="sign in to GitHub" prompt={githubSetupInstructions()} promptLabel="Copy GitHub prompt" />;
}

// The one way to connect a computer, wherever one is needed (owner, 21 October 2026).
export function SetupCard({ connected, onCancel, onContinue, title = 'Bring your AI along.' }: { connected: boolean; onCancel: () => void; onContinue: () => void; title?: string }) {
  return <div className="k42-first-ai">
    <div className="k42-first-ai-body">
      <h2 className="k42-first-ai-title">{title}</h2>
      <SetupSteps />
      <div className="k42-first-ai-footer"><Button className="k42-ph-thin" type="button" onClick={onCancel}>Not now</Button><Button className="primary" type="button" disabled={!connected} onClick={onContinue}>{connected ? <><Check size={16} aria-hidden="true" />Continue</> : 'Waiting for your computer…'}</Button></div>
    </div>
  </div>;
}
