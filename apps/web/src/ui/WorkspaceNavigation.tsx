import { Button } from './Button';
import { personInitials } from './person-initials';
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { projectGradient } from './project-gradient';
import { ArrowLeft, Folder, Plus, LockKeyhole, PanelLeftClose, PanelLeftOpen, Globe, SquareTerminal } from 'lucide-react';
import './workspace.css';
import { CodingAgentAvatar } from './CodingAgentAvatar';
import { PrivateBadge, PrivateNote } from './PrivateBadge';
import { groupAgents } from './agent-running-state';
import { CheatSheetButton } from './ProjectCheatSheet';
import { useAnchoredPopover } from './use-anchored-popover';

export interface WorkspaceNavItem { id: string; label: string; icon?: ReactNode; href: string; current?: boolean; locked?: string; onNavigate: () => void; }
/** `private` marks a project that is not listed in Explore: a lock on its stamp (shell polish 2026-10-18, section 12). */
/** `cover` is a loaded image URL for the project's stamp: the screenshot on its newest update. */
/** A running project says nothing about itself in the menu; only other states are named (owner, 11 November 2026). */
const shownStatus = (status?: string) => !!status && status !== 'Active';
export interface WorkspaceShortcut { id: string; name: string; href: string; onNavigate: () => void; current?: boolean; status?: string; locked?: string; private?: boolean; cover?: string | null; }
/** Project mode (shell polish 2026-10-18, section 12): inside a project the menu shows its identity and own-agent shortcuts. */
export interface ProjectMenu {
  id: string; name: string; status?: string; private?: boolean; cover?: string | null;
  /** "← All projects": leaving the project restores the global menu. */
  back: WorkspaceNavItem;
  /** Public/guest project shells still use section links; member tabs supply an empty list. */
  sections?: WorkspaceNavItem[];
  /** A thin Add agent button under the sections; it opens the one Add agent dialog. */
  connect?: (() => void) | null;
  /** New task, above the project's sections: opens the New task dialog on the Tasks page; absent when Tasks is off or the viewer can't add. */
  addTask?: (() => void) | null;
  /** My agents in this project, under Add agent; nothing shows without any. */
  /** Cheat sheet: opens the project's prompts in a popup; absent for a closed project. */
  cheatSheet?: { title: string; started: boolean } | null;
  myAgents?: { state?: import('@mlswarm/contracts').CommunicationAgentState; provider?: string; personaChoice?: import('@mlswarm/contracts').PersonaChoice | null; id: string; ownerId?: string; name: string; status: string; detail: string; waiting?: boolean; href: string; onNavigate: () => void }[];
}
export interface WorkspaceNavigationProps {
  /** Global mode: the links above the projects (Explore). */
  globals: WorkspaceNavItem[];
  /** Global mode: the "Your projects" heading links here (My projects). */
  projectsLink?: WorkspaceNavItem;
  projects: WorkspaceShortcut[];
  projectStatus?: ReactNode;
  /** Inside a project: replaces the global links and the project shortcuts. */
  project?: ProjectMenu | null;
  /** Links at the foot of the column, above `footer`. */
  secondary?: WorkspaceNavItem[];
  brand?: ReactNode;
  footer?: ReactNode;
  /** Desktop icon rail (shell polish 2026-10-18): icons and stamps only; names stay as tooltips and accessible text. */
  collapsed?: boolean;
  onCollapsedChange?: (value: boolean) => void;
}

const initials = personInitials;
/** The project stamp: its cover where it has one, else its initials on the project's gradient (a sharp square, unlike people and agents); a lock when it is private. */
function ProjectStamp({ project, className = '' }: { project: { id: string; name: string; private?: boolean; cover?: string | null }; className?: string }) {
  const stamp = <span className={`k42-project-stamp${className}`} style={{ background: projectGradient(project.id) }} aria-hidden="true">{project.cover ? <img src={project.cover} alt="" /> : initials(project.name)}</span>;
  return project.private ? <span className="k42-stamp-frame">{stamp}<PrivateBadge /></span> : stamp;
}

/** My agents shows the rows that fit the menu's remaining height, agents that need you first; the rest sit behind "+N more",
 *  which opens a popover list, so the menu never scrolls for them (owner, 11 November 2026). Re-measured when the space or the agents change. */
function useFittedCount(total: number, deps: unknown[]) {
  const box = useRef<HTMLDivElement>(null), list = useRef<HTMLUListElement>(null);
  const [count, setCount] = useState(total), [tick, setTick] = useState(0), [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = box.current; if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { setTick(n => n + 1); setWidth(element.clientWidth); }); observer.observe(element);
    return () => observer.disconnect();
  // The menu's box appears only once a project is open, so it is watched again when that changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useLayoutEffect(() => {
    const element = box.current, rows = list.current; if (!element || !rows) return;
    const row = rows.querySelector<HTMLElement>('.k42-my-agent')?.parentElement, step = row ? row.offsetHeight + 2 : 50;
    const heading = rows.querySelector<HTMLElement>('.k42-my-agent-group')?.offsetHeight ?? 0;
    const slack = element.clientHeight - element.scrollHeight;
    const shown = Math.min(count, total);
    // Too tall: drop rows. Room for another row (and a group heading it might bring): add rows. Each pass settles the next.
    if (slack < 0 && shown > 0) setCount(Math.max(0, shown - Math.ceil(-slack / step)));
    else if (shown < total && element.scrollHeight <= element.clientHeight && slack >= step + heading) setCount(Math.min(total, shown + Math.max(1, Math.floor((slack - heading) / step))));
    else if (count !== shown) setCount(shown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, total, tick, ...deps]);
  return { box, list, count: Math.min(count, total), width };
}
export function WorkspaceNavigation({ globals, projectsLink, projects, projectStatus, project, secondary = [], brand, footer, collapsed = false, onCollapsedChange }: WorkspaceNavigationProps) {
  const text = (label: ReactNode) => <span className={collapsed ? 'k42-nav-text' : undefined}>{label}</span>;
  // Collapsed links retain their accessible names and tooltips.
  const link = (item: WorkspaceNavItem, children: ReactNode, className = 'k42-nav-link', { currentKind = 'page' }: { currentKind?: 'page' | 'location' } = {}) => {
    const tip = collapsed ? item.label : undefined;
    return item.locked ? <span role="link" aria-disabled="true" tabIndex={0} title={tip ? `${item.label}. ${item.locked}` : item.locked} aria-label={`${item.label}. ${item.locked}`} className={`${className} k42-nav-locked`}>{children}{!tip && <LockKeyhole size={13} aria-hidden="true" />}</span> : <a href={item.href} className={className} title={tip} aria-label={collapsed ? item.label : undefined} aria-current={item.current ? currentKind : undefined} onClick={e => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault(); item.onNavigate();
    }}>{children}</a>;
  };
  const list = (items: WorkspaceNavItem[]) => <ul>{items.map(item => <li key={item.id}>{link(item, <>{item.icon}{text(item.label)}</>)}</li>)}</ul>;
  const label = (value: string) => <p className={`k42-nav-label${collapsed ? ' k42-nav-text' : ''}`}>{value}</p>;
  const agents = groupAgents(project?.myAgents ?? []);
  const fitted = useFittedCount(agents.length, [collapsed, project?.id, !!project?.connect]);
  // The open menu shows My agents as one line of overlapping faces, like the map's, with +N once the line is full (owner, 12 November 2026).
  // Each face is 32px and overlaps the previous by 8px; +N takes about 40px. The collapsed rail keeps one face per row, as many as fit.
  const fits = (room: number) => room < 32 ? 0 : 1 + Math.floor((room - 32) / 24);
  const room = fitted.width - 12, stripCount = fits(room) >= agents.length ? agents.length : fits(room - 44);
  const strip = !collapsed ? agents.slice(0, Math.max(0, stripCount)) : [];
  const shownAgents = collapsed ? agents.slice(0, fitted.count) : [], hiddenAgents = agents.slice(collapsed ? fitted.count : strip.length);
  const more = useAnchoredPopover<HTMLDivElement>({ align: 'start', above: true });
  // In the +N popover a row always shows its name and status, even from the collapsed rail.
  const agentRow = ({ agent }: (typeof agents)[number], onNavigate = agent.onNavigate, full = false) => link({ id: agent.id, label: `${agent.name}, ${agent.waiting ? 'waiting for you' : agent.status}`, href: agent.href, onNavigate },
    <><CodingAgentAvatar provider={agent.provider} status={{ state: agent.state, label: agent.waiting ? 'Waiting for you' : agent.status }} name={agent.name} id={agent.id} ownerId={agent.ownerId} persona={agent.personaChoice} size={32} decorative />{(full ? (v: ReactNode) => <span>{v}</span> : text)(<span className="k42-my-agent-text"><strong>{agent.name}</strong><small>{agent.detail}</small></span>)}</>, 'k42-nav-link k42-my-agent');
  const toggleLabel = collapsed ? 'Expand menu' : 'Collapse menu';
  return <div className={`k42-navigation${collapsed ? ' is-collapsed' : ''}${project ? ' is-project' : ''}`}>
    {(brand || onCollapsedChange) && <div className="k42-nav-brand">{!collapsed && brand}{onCollapsedChange && <Button type="button" className="k42-nav-collapse" aria-expanded={!collapsed} aria-label={toggleLabel} title={toggleLabel} onClick={() => onCollapsedChange(!collapsed)}>{collapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}</Button>}</div>}
    {/* The top of the menu is the same everywhere; only the part below it changes inside a project (owner, 19 October 2026). */}
    {/* My projects sits under Explore (owner, 19 October 2026); projects are created from Claude (owner, 10 November 2026). */}
    {(globals.length > 0 || projectsLink) && <nav aria-label="Workspace"><ul>
      {globals.map(item => <li key={item.id}>{link(item, <>{item.icon}{text(item.label)}</>)}</li>)}
      {projectsLink && <li>{link({ ...projectsLink, label: 'My projects' }, <><Folder size={18} aria-hidden="true" />{text('My projects')}</>)}</li>}
    </ul></nav>}
    {project ? <div className="k42-shortcuts k42-project-menu">
      <nav aria-label="Project">
        {/* Inside a project (owner, 19 October 2026): back, its identity, then My agents. */}
        <ul className="k42-nav-back"><li>{link(project.back, <><ArrowLeft size={16} aria-hidden="true" />{text(project.back.label)}</>)}</li></ul>
        <div className="k42-nav-project" title={collapsed ? project.name : undefined}>
          <ProjectStamp project={project} className=" is-large" />
          <span className={collapsed ? 'k42-nav-text' : 'k42-nav-project-text'}><strong>{project.name}</strong>{project.private && <PrivateNote />}{shownStatus(project.status) && <small>{project.status}</small>}</span>
        </div>
        {/* New task sits above the project's sections (owner, 11 November 2026). */}
        {project.addTask && <ul className="k42-nav-add-task"><li><button type="button" className="primary k42-nav-add-task-button" onClick={project.addTask} title={collapsed ? 'New task' : undefined} aria-label={collapsed ? 'New task' : undefined}>
          <Plus size={collapsed ? 18 : 16} aria-hidden="true" />{text('New task')}</button></li></ul>}
        {!!project.sections?.length && list(project.sections)}
      </nav>
      <div className="k42-project-scroll" ref={fitted.box}>
      {(project.connect || !!project.myAgents?.length) && <nav className="k42-my-agents" aria-label="My agents">
        {label('My agents')}
        <ul ref={fitted.list}>
          {shownAgents.map(row => <li key={row.agent.id}>{agentRow(row)}</li>)}
          {(strip.length > 0 || hiddenAgents.length > 0) && <li className={strip.length ? 'k42-my-agent-strip' : undefined}>{strip.map(({ agent }) => {
            const name = `${agent.name}, ${agent.waiting ? 'waiting for you' : agent.status}`;
            return <a key={agent.id} href={agent.href} className="k42-my-agent-chip" title={`${agent.name} · ${agent.waiting ? 'Waiting for you' : agent.status}`} aria-label={name}
              onClick={e => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); agent.onNavigate(); }}>
              <CodingAgentAvatar provider={agent.provider} status={{ state: agent.state, label: agent.waiting ? 'Waiting for you' : agent.status }} name={agent.name} id={agent.id} ownerId={agent.ownerId} persona={agent.personaChoice} size={32} decorative /></a>;
          })}{hiddenAgents.length > 0 && <><button type="button" className="k42-nav-more" {...more.triggerProps} title={collapsed ? `${hiddenAgents.length} more agents` : undefined}
            aria-label={`${hiddenAgents.length} more agents${hiddenAgents.some(row => row.agent.waiting) ? ', some waiting for you' : ''}`}>
            +{hiddenAgents.length}{hiddenAgents.some(row => row.agent.waiting) && <span className="k42-nav-more-waiting" aria-hidden="true" />}</button>
            <div {...more.panelProps} className={`${more.panelProps.className} k42-my-agents-more`} aria-label="More agents">
              <ul>{hiddenAgents.map((row, i) => <Fragment key={row.agent.id}>{new Set(hiddenAgents.map(r => r.group)).size > 1 && row.group !== hiddenAgents[i - 1]?.group && <li className="k42-my-agent-group">{row.group}</li>}
                <li>{agentRow(row, () => { more.close(false); row.agent.onNavigate(); }, true)}</li></Fragment>)}</ul>
            </div></>}</li>}
          {project.connect && <li><button type="button" className="k42-nav-link k42-nav-create" onClick={project.connect} title={collapsed ? 'Add agent' : undefined} aria-label={collapsed ? 'Add agent' : undefined}>
            {/* Looks like New project: the label with its plus on the right (owner, 21 October 2026). */}
            {collapsed && <Plus size={18} aria-hidden="true" />}{text('Add agent')}{!collapsed && <span className="k42-nav-create-plus" aria-hidden="true"><Plus size={16} /></span>}</button></li>}
        </ul>
      </nav>}
      </div>
    </div> : <>
      {(projects.length > 0 || projectStatus) && <nav className="k42-shortcuts" aria-label="Your projects">
        <div className="k42-nav-heading">
          {label('Your projects')}
        </div>
        {!collapsed && projectStatus}
        <ul>{projects.map(shortcut => <li key={shortcut.id}>{link({ id: shortcut.id, label: shortcut.name, href: shortcut.href, locked: shortcut.locked, current: shortcut.current, onNavigate: shortcut.onNavigate }, <>
          {/* Private or shared, at a glance on every row (owner, 19 October 2026): a lock or a globe at the row's end. */}
          <ProjectStamp project={{ ...shortcut, private: collapsed && shortcut.private }} />{collapsed ? text(<>{shortcut.name}{shortcut.private ? <PrivateNote /> : <span className="visually-hidden">, shared project</span>}</>) : <span>{shortcut.name}{shortcut.private ? <PrivateNote /> : <span className="visually-hidden">, shared project</span>}{shownStatus(shortcut.status) && <small>{shortcut.status}</small>}</span>}
          {!collapsed && <span className={`k42-project-kind${shortcut.private ? ' is-private' : ''}`} title={shortcut.private ? 'Private project' : 'Shared project'} aria-hidden="true">{shortcut.private ? <LockKeyhole size={14} /> : <Globe size={14} />}</span>}
        </>, 'k42-project-title', { currentKind: 'location' })}</li>)}</ul>
      </nav>}
    </>}
    {(secondary.length > 0 || footer || project?.cheatSheet) && <div className="k42-nav-footer">
      {/* Cheat sheet sits above Karma progress, where it stays in view however many agents there are. */}
      {project?.cheatSheet && <nav aria-label="Cheat sheet"><ul><li><CheatSheetButton title={project.cheatSheet.title} started={project.cheatSheet.started} className="k42-nav-link k42-nav-create" label={collapsed ? 'Cheat sheet' : undefined}>
        <SquareTerminal size={18} aria-hidden="true" />{text('Cheat sheet')}</CheatSheetButton></li></ul></nav>}
      {secondary.length > 0 && <nav aria-label="More">{list(secondary)}</nav>}
      {footer}
    </div>}
  </div>;
}
