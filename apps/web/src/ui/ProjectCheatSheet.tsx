import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, SquareTerminal } from 'lucide-react';
import { projectCheatSheet } from '../project-chat-prompt';
import { Button } from './Button';
import { CloseButton } from './CloseButton';
import { copyText } from './ComputerSetup';
import { Dialog } from './Dialog';
import './project-tasks.css';
import './project-people.css';

/** Which projects' Add your agent reminder the person closed, remembered on this device. */
const NUDGE_KEY = 'k42.addAgentNudgeClosed';
const storage = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

function CopyPrompt({ action, prompt }: { action: string; prompt: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return <Button className="soft k42-run-icon" type="button" aria-label={copied ? 'Copied' : `Copy prompt: ${action}`} title={copied ? 'Copied' : copied === false ? 'Select and copy' : 'Copy prompt'} onClick={() => void copyText(prompt).then(setCopied)}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</Button>;
}

// What the person can ask their coding chat in this project: action, then the prompt to copy.
function CheatSheetTable({ title, started, highlightAdd = false }: { title: string; started: boolean; highlightAdd?: boolean }) {
  return <>
    <p>Copy a prompt into your coding chat.{!started && ' Agents you add start when the project starts.'}</p>
    <div className="k42-tasks-tablewrap k42-cheatsheet"><table className="k42-tasks-table"><thead><tr><th scope="col">To</th><th scope="col">Prompt</th><th scope="col"><span className="visually-hidden">Copy</span></th></tr></thead>
      <tbody>{projectCheatSheet(title).map(([action, prompt]) => <tr key={action} className={highlightAdd && action === 'Add an agent' ? 'k42-cheatsheet-highlight' : undefined}><th scope="row">{action}</th><td><code>{prompt}</code></td><td><CopyPrompt action={action} prompt={prompt} /></td></tr>)}</tbody></table></div>
  </>;
}

// Home no longer carries the table (Noa, 26 October 2026). While you have no agent in this project, a small reminder
// opens the cheat sheet at Add an agent; it goes once you add one, or when you close it (per project, this device).
export function AddAgentNudge({ projectId, title, started }: { projectId: string; title: string; started: boolean }) {
  const read = () => { try { return (JSON.parse(storage()?.getItem(NUDGE_KEY) ?? '[]') as string[]).includes(projectId); } catch { return false; } };
  const [closed, setClosed] = useState(read);
  if (closed) return null;
  const close = () => { try { const list = JSON.parse(storage()?.getItem(NUDGE_KEY) ?? '[]') as string[]; storage()?.setItem(NUDGE_KEY, JSON.stringify([...new Set([...list, projectId])].slice(-200))); } catch { /* Blocked storage closes it for this visit only. */ } setClosed(true); };
  return <aside className="k42-add-agent-nudge" aria-label="Add your agent">
    <span className="k42-add-agent-nudge-icon" aria-hidden="true"><SquareTerminal size={18} /></span>
    <div><strong>Add your agent</strong><span>Copy one prompt to bring an agent here.</span></div>
    <CheatSheetButton title={title} started={started} className="k42-add-agent-nudge-open" highlightAdd>Show me how</CheatSheetButton>
    <CloseButton onClick={close} />
  </aside>;
}

// Cheat sheet in the project menu: opens the same table in a popup.
export function CheatSheetButton({ title, started, className, label, highlightAdd = false, children }: { title: string; started: boolean; className?: string; label?: string; highlightAdd?: boolean; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  return <>
    <button type="button" className={className} title={label} aria-label={label} onClick={() => { dialog.current?.showModal(); if (highlightAdd) dialog.current?.querySelector<HTMLButtonElement>('.k42-cheatsheet-highlight button')?.focus(); }}>{children}</button>
    {createPortal(<Dialog ref={dialog} className="agent-connect-dialog" aria-labelledby={titleId}>
      <div className="k42-contrib-body">
        <div className="agent-connections-heading"><h2 id={titleId}>Cheat sheet</h2><CloseButton onClick={() => dialog.current?.close()} /></div>
        <CheatSheetTable title={title} started={started} highlightAdd={highlightAdd} />
      </div>
    </Dialog>, document.body)}
  </>;
}
