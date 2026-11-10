import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Globe, Lock } from 'lucide-react';
import { Dialog } from '../Dialog';
import { Button } from '../Button';
import { CloseButton } from '../CloseButton';
import { MarkdownField } from '../MarkdownField';
import { projectGradient } from '../project-gradient';
import { emptyProjectSetupDraft, setupSteps, setupStep, type ProjectSetupDraft, type ProjectSetupMode, type ProjectSetupStepProps } from './types';
import { validateSetupStep, validatePublicDraft } from './validation';
import './project-setup-modal.css';

export interface ProjectSetupModalProps {
  /** Set from the New project menu, so the first screen is the name and description. */
  visibilityChosen?: boolean;
  open: boolean;
  mode?: ProjectSetupMode;
  onClose: () => void;
  locked?: boolean;
  busy?: boolean;
  errorMessage?: string | null;
  retrying?: boolean;
  onRetryAccount?: () => void;
  status?: string;
  submitDisabled?: boolean;
  onSaveDraft?: (draft: ProjectSetupDraft, mode: ProjectSetupMode) => void;
  maximumContributors?: number | null;
  privateLimits?: PrivateLimits | null;
  initialDraft?: Partial<ProjectSetupDraft>;
  initialStep?: number;
  preview?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onConfirm?: (draft: ProjectSetupDraft, mode: ProjectSetupMode) => void;
}

export type PrivateLimits = { people: number; agentsPerPerson: number };

const visibilityChoices = [
  { value: 'private', title: 'Private', Icon: Lock, tone: 'k42-tone-mint', copy: 'Only you and your agents' },
  { value: 'public', title: 'Public', Icon: Globe, tone: 'k42-tone-sky', copy: 'Open to everyone after community review' },
] as const;

const QUESTIONS = [['🔐', 'Private or public?'], ['✨', 'What are we working on?'], ['📦', 'Where does the code live?']];

const DESCRIPTION_STARTERS = [
  { emoji: '🧩', label: 'Build an app', text: 'Build a small app that helps people ' },
  { emoji: '🎮', label: 'Make a game', text: 'Make a playable browser game where ' },
  { emoji: '🔬', label: 'Research', text: 'Research and summarise what we know about ' },
  { emoji: '📚', label: 'Write docs', text: 'Write clear, friendly documentation for ' },
  { emoji: '🛠️', label: 'Improve a project', text: 'Improve the open-source project ' },
];

export function BasicsStep({ draft, onChange }: ProjectSetupStepProps) {
  const descriptionId = useId();
  function start(text: string) {
    onChange({ purpose: text });
    window.requestAnimationFrame(() => { const box = document.getElementById(descriptionId) as HTMLTextAreaElement | null; box?.focus(); box?.setSelectionRange(text.length, text.length); });
  }
  return <div className="setup-section">
    <label className="setup-field">Project name <input autoComplete="off" required maxLength={120} value={draft.name} placeholder="For example, Product research" onChange={event => onChange({ name: event.target.value })} /></label>
    <div className="setup-field"><label htmlFor={descriptionId}>Description</label>
      <div className="setup-starters" role="group" aria-label="Start from an idea">{DESCRIPTION_STARTERS.map(starter => <button key={starter.label} type="button" className="setup-starter-chip" onClick={() => start(starter.text)}><span aria-hidden="true">{starter.emoji}</span>{starter.label}</button>)}</div>
      <MarkdownField id={descriptionId} required maxLength={1500} rows={3} value={draft.purpose} placeholder="Pick an idea above and finish the sentence, or write your own" onChange={event => onChange({ purpose: event.target.value })} /></div>
  </div>;
}

/** Shared setup presentation, with transport supplied by the authenticated controller. */
export function ProjectSetupModal({ visibilityChosen = false, open, mode: initialMode = 'private', onClose, locked = false, busy = false, errorMessage, retrying = false, onRetryAccount, status, submitDisabled = false, onSaveDraft, maximumContributors, privateLimits, initialDraft, initialStep, preview = false, onDirtyChange, onConfirm }: ProjectSetupModalProps) {
  const first = visibilityChosen ? setupStep.Basics : setupStep.Visibility;
  const [mode, setMode] = useState<ProjectSetupMode>(initialMode);
  const [draft, setDraft] = useState<ProjectSetupDraft>(() => ({ ...emptyProjectSetupDraft, ...initialDraft, minContributors: 1 }));
  const [step, setStep] = useState(Math.max(first, Math.min(setupStep.Repository, initialStep ?? first)));
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), errorRef = useRef<HTMLParagraphElement>(null);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  useEffect(() => onDirtyChange?.(JSON.stringify(draft) !== JSON.stringify({ ...emptyProjectSetupDraft, ...initialDraft, minContributors: 1 })), [draft, initialDraft, onDirtyChange]);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => { if (open) heading.current?.focus(); }, [step, open]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  function update(patch: Partial<ProjectSetupDraft>) { setDraft(value => ({ ...value, ...patch })); setError(null); }
  function choose(value: ProjectSetupMode) { setMode(value); setError(null); }
  function arrow(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const next = mode === 'private' ? 1 : 0;
    choose(visibilityChoices[next].value); tiles.current[next]?.focus();
  }
  function next() {
    const problem = validateSetupStep(step, mode, draft, maximumContributors);
    if (problem) { setError(problem); return; }
    if (step < setupStep.Repository) setStep(step + 1);
    else { if (preview) setConfirmed(true); onConfirm?.({ ...draft, minContributors: 1 }, mode); }
  }
  function back() { setStep(step - 1); setError(null); }
  const last = step === setupStep.Repository;
  const screens = setupSteps.length - first, screen = step - first;
  const [emoji, question] = QUESTIONS[step];
  return <Dialog ref={dialog} className="project-setup-modal" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClose={() => { if (open) onClose(); }}>
    <form noValidate onSubmit={event => { event.preventDefault(); next(); }}>
      {/* The new project's own gradient, the same as it will have everywhere, with its private or public mark (owner, 19 October 2026). */}
      <div className="setup-banner" style={{ background: projectGradient(draft.name.trim() || 'new project') }} aria-hidden="true">
        <span className="setup-banner-stamp">{mode === 'private' ? <Lock size={20} /> : <Globe size={20} />}</span></div>
      <div className="setup-progress" role="progressbar" aria-label="Create project progress" aria-valuemin={1} aria-valuemax={screens} aria-valuenow={screen + 1}><span style={{ width: `${(screen + 1) / screens * 100}%` }} /></div>
      <fieldset className="setup-controls" disabled={locked}>
        <header className="setup-header"><CloseButton label="Close setup" disabled={busy} onClick={onClose} /></header>
        <div className="setup-body" data-setup-step={setupSteps[step]}>
          <h2 id={`${id}-title`} className="setup-question" ref={heading} tabIndex={-1}><span aria-hidden="true">{emoji} </span>{question}</h2>
          {step === setupStep.Visibility && <div className="setup-visibility" role="radiogroup" aria-label="Project visibility" onKeyDown={arrow}>{visibilityChoices.map(({ value, title, Icon, tone, copy }, index) => <button key={value} ref={element => { tiles.current[index] = element; }} type="button" role="radio" aria-checked={mode === value} tabIndex={mode === value ? 0 : -1} onClick={() => choose(value)}><span className={`setup-visibility-icon ${tone}`} aria-hidden="true"><Icon size={22} /></span><strong>{title}</strong><span className="setup-help">{copy}</span>{privateLimits && <span className="setup-help setup-visibility-limits">{value === 'private' ? `Up to ${privateLimits.agentsPerPerson} agents.` : `${maximumContributors != null ? `Up to ${maximumContributors} people including you` : 'Unlimited people'} · up to ${privateLimits.agentsPerPerson} agents per person.`}</span>}</button>)}</div>}
          {step === setupStep.Basics && <BasicsStep mode={mode} draft={draft} onChange={update} />}
          {!confirmed && last && <div className="setup-section">
            <label className="setup-field">GitHub repository<input required maxLength={300} value={draft.repository} placeholder="github.com/owner/repository" onChange={event => update({ repository: event.target.value })} /></label>
          </div>}
          {last && !confirmed && <div className="setup-summary setup-inline-summary" aria-label="Project summary">
            <div className="setup-summary-row"><div><strong>{draft.name.trim()}</strong><p className="setup-help">{mode === 'private' ? 'Private · invited people only' : 'Public · community review required'}</p></div><Button type="button" className="setup-edit" onClick={() => { setStep(setupStep.Basics); setError(null); }}>Edit basics</Button></div>
            <p className="setup-help">{mode === 'private' ? 'Creates your project. Connect your own agents when ready.' : 'Approval creates an unlisted, unstarted project. Publication and agent execution are separate.'}</p>
          </div>}
          {confirmed && <p className="setup-confirmed" role="status">Synthetic preview confirmed. No project, proposal, invitation or model run was created.</p>}
          {error && <p ref={errorRef} tabIndex={-1} className="setup-error" role="alert">{error}</p>}
        </div>
      </fieldset>
      {errorMessage && <p className="setup-error" role="alert">{errorMessage}</p>}
      {status && <p className="setup-help setup-status" role="status">{status}</p>}{onRetryAccount && <div className="setup-status"><Button type="button" onClick={onRetryAccount}>Check account again</Button></div>}
      <footer className="setup-footer"><div className="setup-footer-actions">
        <Button type="button" className="setup-back" disabled={locked || step === first} onClick={back}>Back</Button>
        {mode === 'public' && onSaveDraft && step > setupStep.Visibility && <Button type="button" disabled={locked || submitDisabled} onClick={() => { const problem = validatePublicDraft(draft); if (problem) setError(problem); else onSaveDraft(draft, mode); }}>Save draft</Button>}
        <Button className="primary" type="submit" disabled={confirmed || busy || last && submitDisabled}>{busy ? 'Saving…' : retrying ? 'Retry same request' : !last ? 'Continue' : mode === 'private' ? 'Create project' : 'Submit for review'}</Button>
      </div></footer>
    </form>
  </Dialog>;
}
