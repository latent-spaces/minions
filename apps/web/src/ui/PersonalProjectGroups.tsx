import { sharedLink } from '../shared-link';
import { Button } from './Button';
import { Archive, RotateCcw, Link as LinkIcon, LogOut, Settings, type LucideIcon, Star, StarOff } from 'lucide-react';
import type { PersonalProjectEntry } from '../project-api';
import { formatRoute, projectRoute, type Route } from '../route';
import type { HeaderMenuItem } from './ProjectHeader';
import { ClaudePromptTile } from './ClaudePromptTile';
import { ExploreProjectCard } from './ExploreProjectCard';
import { groupPersonalProjects, personalFilterChips, type PersonalFilter } from './group-personal-projects';
import { personalProjectStatus } from './personal-project-status';
import './personal-project-groups.css';

// Project administration and personal membership actions keep their own destinations.
function manageMenu(project: PersonalProjectEntry, go: (to: Route) => void, onStar?: (project: PersonalProjectEntry) => void, onLeave?: (id: string) => void): HeaderMenuItem[] {
  const icon = (Icon: LucideIcon) => <Icon size={18} aria-hidden="true" />;
  if (project.kind === 'proposal') return [];
  const items: HeaderMenuItem[] = [];
  // A star keeps the project in your menu column (owner, 19 October 2026).
  if (onStar) items.push({ id: 'star', label: project.starred ? 'Remove star' : 'Star · keep in my menu', icon: icon(project.starred ? StarOff : Star), onSelect: () => onStar(project) });
  if (project.role === 'owner') items.push({ id: 'control', label: 'Settings', icon: icon(Settings), onSelect: () => go(projectRoute(project.id, 'control-center')) });
  if (project.role !== 'owner' && project.private && onLeave) items.push({ id: 'leave', label: 'Leave project', icon: icon(LogOut), onSelect: () => onLeave(project.id) });
  items.push({ id: 'copy', label: 'Copy project link', icon: icon(LinkIcon), onSelect: () => { void sharedLink(`/${formatRoute(projectRoute(project.id))}`).then(link => navigator.clipboard.writeText(link)).catch(() => undefined); } });
  return items;
}

// Counts come from the loaded page only. They never imply directory totals.
export function PersonalFilterChips({ projects, archived, value, disabled = false, onChange }: { projects: PersonalProjectEntry[]; archived: PersonalProjectEntry[]; value: PersonalFilter; disabled?: boolean; onChange: (value: PersonalFilter) => void }) {
  return <div className="k42-category-chips personal-project-filter" role="group" aria-label="Filter my projects">
    {personalFilterChips(projects, archived).map(({ key, label, count }) => <button type="button" key={key} className={count ? undefined : 'is-empty'} aria-pressed={value === key} disabled={disabled} onClick={() => onChange(key)}>{label} · {count}</button>)}
  </div>;
}

// One grid with no group headings (Noa, 26 October 2026): the Claude prompt first, then every project in the list.
// The card's small tag says which kind it is (Owner, a joined role, or Waiting); the chips only switch to Archived.
// `searching` is true while the page is filtered by a search: an empty result is then a search result, not an invitation.
export function PersonalProjectGroups({ projects, covers, go, searching = false, onArchive, onStar, onLeave, disabled = false, archived = false }: { projects: PersonalProjectEntry[]; /** Loaded cover images by project id. */ covers?: Record<string, string>; go: (to: Route) => void; searching?: boolean; onArchive?: (project: PersonalProjectEntry) => void; onStar?: (project: PersonalProjectEntry) => void; onLeave?: (id: string) => void; disabled?: boolean; archived?: boolean }) {
  const grouped = groupPersonalProjects(projects, archived);
  const shown = (['owner', 'joined', 'waiting'] as const).flatMap(key => grouped[key].map(project => ({ project, waiting: key === 'waiting' })));
  const prompt = !archived && !searching;
  return <div className="personal-project-groups">
    {prompt && <ClaudePromptTile />}
    {shown.map(({ project, waiting }) => {
      const state = personalProjectStatus(project);
      const act = () => { if (project.kind !== 'proposal') go(projectRoute(project.id, state.settings ? 'control-center' : 'overview')); };
      return <ExploreProjectCard key={project.id} cover={covers?.[project.id] ?? project.coverImage ?? null} menu={[...manageMenu(project, go, disabled ? undefined : onStar, disabled ? undefined : onLeave), ...(onArchive && !project.archived && !disabled ? [{ id: 'archive', label: 'Archive for me', icon: <Archive size={18} aria-hidden="true" />, onSelect: () => onArchive(project) }] : [])]} footerAction={onArchive && project.archived ? <Button className="personal-project-restore" disabled={disabled} onClick={() => onArchive(project)} aria-label={`Restore ${project.name}`}><RotateCcw size={16} aria-hidden="true" />Restore</Button> : undefined} headingLevel={2} projectId={project.id} icon={null} private={project.private} title={project.name} summary={project.summary} category={waiting ? 'Waiting' : { owner: 'Owner', member: 'Member' }[project.role]} status={state.label} statusHelp={state.help} visibilityLabel={state.visibility} participantCount={project.participantCount ?? null} minContributors={project.minContributors} startDeadline={project.startDeadline} recruiting={project.state ? project.state.admission !== 'direct_private' && ['recruiting', 'ready_to_start'].includes(project.state.status) : project.listed === true && project.execution === 'ready' && project.lifecycle !== 'setup'} reviewPending={project.kind === 'proposal' && project.proposalStatus === 'submitted'} actionLabel={state.action} onAction={act} />;
    })}
  </div>;
}
