import { projectRoute, type Route } from '../route.js';

// Projects first in the menu (shell polish 2026-10-18, section 12): pure rules for the sidebar modes and the top bar.

/** Project mode while the open project is the one the route names; anywhere else, including a project still loading, the global menu. */
export function menuMode(route: Route, shownProjectId: string | null): 'global' | 'project' {
  return route.view === 'project' && shownProjectId !== null && route.projectId === shownProjectId ? 'project' : 'global';
}

/** A project's sections, in the order of its tabs. */

// The service searches by up to 40 characters of an agent name.
const SEARCH_LIMIT = 40;

/** Where the top bar's search goes: the open project's agent search. An empty submit, or no open project, does nothing. */
export function searchTarget(text: string, projectId: string | null): Route | null {
  const q = text.trim().slice(0, SEARCH_LIMIT);
  return projectId !== null && q ? projectRoute(projectId, 'agents', null, q, 'all') : null;
}

/** The scope the search box belongs to: the box resets whenever the key changes. */
export const searchScope = (projectId: string | null) => projectId !== null ? `project:${projectId}` : 'global';

export const searchPlaceholder = (projectName: string) => `Search in ${projectName}`;

/** Ctrl K, or Cmd K on a Mac, focuses the search. */
export function isSearchShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
}

/** Links keep agent detail addressable; ordinary activation can open its requests in place. */
export function sidebarAgentRoute(projectId: string, agent: { id: string; waiting?: boolean; queued?: boolean }): Route {
  return projectRoute(projectId, 'agents', agent.queued ? null : agent.id);
}
