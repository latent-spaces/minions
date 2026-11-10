import type { PersonalProjectEntry } from '../project-api';
import { personalProjectLifecycle } from './personal-project-status';

export type PersonalFilter = 'all' | 'owner' | 'joined' | 'waiting' | 'archived';

// Waiting: the person's proposals, and their own projects still in review (not approved or not yet published).
// Joined: any role other than owner. Owner: the rest of the person's own projects.
// Archived is its own state (owner, 26 October 2026): archived entries never count in Owner, Joined, Waiting or All.
// The Archived list itself passes `includeArchived` to group its own entries.
export function groupPersonalProjects(entries: PersonalProjectEntry[], includeArchived = false) {
  const owner: PersonalProjectEntry[] = [], joined: PersonalProjectEntry[] = [], waiting: PersonalProjectEntry[] = [];
  for (const entry of entries) {
    if (entry.archived && !includeArchived) continue;
    if (entry.kind === 'proposal') waiting.push(entry);
    else if (entry.role !== 'owner') joined.push(entry);
    else if (['setup_needed', 'not_published'].includes(personalProjectLifecycle(entry).status)) waiting.push(entry);
    else owner.push(entry);
  }
  return { owner, joined, waiting };
}

export const PERSONAL_FILTERS: { key: PersonalFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'owner', label: 'Owner' },
  { key: 'joined', label: 'Joined' }, { key: 'waiting', label: 'Waiting' }, { key: 'archived', label: 'Archived' },
];

// One chip row: every chip stays (muted at 0) so the row never jumps.
export function personalFilterChips(current: PersonalProjectEntry[], archived: PersonalProjectEntry[]) {
  const groups = groupPersonalProjects(current);
  const counts: Record<PersonalFilter, number> = {
    all: groups.owner.length + groups.joined.length + groups.waiting.length,
    owner: groups.owner.length, joined: groups.joined.length, waiting: groups.waiting.length,
    archived: archived.filter(entry => entry.archived !== false).length,
  };
  return PERSONAL_FILTERS.map(chip => ({ ...chip, count: counts[chip.key] }));
}
