import type { ProjectEntry } from '../project-api';

// The authenticated directory contains only owned/joined projects. Opening another
// accessible project must not add a closed or personally archived shortcut.
export function projectShortcuts(projects: ProjectEntry[], selected: ProjectEntry | null, limit: number): ProjectEntry[] {
  // Starred projects always stay, first (owner, 19 October 2026); then projects that aren't closed, including ones
  // waiting to start (owner, 21 October 2026). The server's menu view uses the same rule.
  const eligible = (project: ProjectEntry) => !project.archived && (!!project.starred || (project.state?.status ?? project.execution) !== 'closed');
  const shortcuts = [...projects.filter(project => eligible(project) && project.starred), ...projects.filter(project => eligible(project) && !project.starred)].slice(0, limit);
  if (selected && eligible(selected) && !shortcuts.some(project => project.id === selected.id)) {
    shortcuts.splice(Math.max(0, limit - 1), 1, selected);
  }
  return shortcuts;
}
