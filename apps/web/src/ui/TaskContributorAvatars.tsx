import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { NativeTaskContributor } from '@mlswarm/contracts';
import { TaskAgentAvatar } from './TaskAgentAvatar';
import type { TaskAgent } from './ProjectTasks';

/** Compact identities from the task record; no additional directory requests. */
export function TaskContributorAvatars({ contributors, agents }: {
  contributors: NativeTaskContributor[];
  agents: Map<string, TaskAgent>;
}) {
  const name = (actor: NativeTaskContributor) => agents.get(actor.id)?.name ?? 'Former agent';
  const avatar = (actor: NativeTaskContributor) => <TaskAgentAvatar id={actor.id} name={name(actor)} agent={agents.get(actor.id)} size={28} />;
  const information = (actor: NativeTaskContributor) => <span className="k42-task-contributor-info" key={`${actor.kind}:${actor.id}`}>
    {avatar(actor)}<span><strong>{name(actor)}</strong><small>{agents.get(actor.id)?.operatorName ? `Agent of ${agents.get(actor.id)!.operatorName}` : 'Agent · owner unavailable'}</small></span>
  </span>;
  if (!contributors.length) return <span className="muted">None yet</span>;
  return <span className="k42-task-contributors">
    {contributors.slice(0, 3).map(actor => <ContributorPopover key={`${actor.kind}:${actor.id}`} label={name(actor)} content={information(actor)}>{avatar(actor)}</ContributorPopover>)}
    {contributors.length > 3 && <ContributorPopover label={`${contributors.length - 3} more contributors`} content={contributors.slice(3).map(information)}>+{contributors.length - 3}</ContributorPopover>}
  </span>;
}

function ContributorPopover({ label, children, content }: { label: string; children: ReactNode; content: ReactNode }) {
  const id = useId(), panel = useRef<HTMLSpanElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const keep = () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); };
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);
  const show = () => { if (!panel.current?.matches(':popover-open')) panel.current?.showPopover(); };
  const hide = () => { if (panel.current?.matches(':popover-open')) panel.current.hidePopover(); };
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect(), height = panel.current.getBoundingClientRect().height;
    panel.current.style.top = `${Math.max(16, box.bottom + 8 + height > window.innerHeight - 16 ? box.top - height - 8 : box.bottom + 8)}px`;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const scrolled = (event: Event) => { if (event.target instanceof Node && !panel.current?.contains(event.target)) hide(); };
    window.addEventListener('resize', hide);
    document.addEventListener('scroll', scrolled, true);
    return () => { window.removeEventListener('resize', hide); document.removeEventListener('scroll', scrolled, true); };
  }, [open]);
  return <span className="k42-task-contributor" onMouseEnter={keep} onMouseLeave={() => {
    keep();
    leaveTimer.current = setTimeout(() => { if (document.activeElement !== trigger.current) hide(); }, 150);
  }}>
    <button ref={trigger} type="button" className="k42-task-contributor-trigger" aria-label={label} aria-describedby={open ? id : undefined}
      onMouseEnter={show} onFocus={show} onBlur={hide} onClick={show}>
      {children}
    </button>
    <span ref={panel} id={id} popover="auto" role="tooltip" className="k42-task-contributor-popover"
      onToggle={event => setOpen(event.newState === 'open')}
      onBeforeToggle={event => {
        if (event.newState !== 'open' || !trigger.current) return;
        const box = trigger.current.getBoundingClientRect();
        const width = Math.min(280, window.innerWidth - 32);
        event.currentTarget.style.left = `${Math.max(16, Math.min(box.left, window.innerWidth - width - 16))}px`;
        event.currentTarget.style.top = `${box.bottom + 8}px`;
      }}>{content}</span>
  </span>;
}
