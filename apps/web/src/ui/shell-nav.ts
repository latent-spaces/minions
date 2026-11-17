import { projectRoute, type Route } from '../route.js';

// Projects first in the menu (shell polish 2026-10-18, section 12): pure rules for the sidebar modes.

/** Project mode while the open project is the one the route names; anywhere else, including a project still loading, the global menu. */
export function menuMode(route: Route, shownProjectId: string | null): 'global' | 'project' {
  return route.view === 'project' && shownProjectId !== null && route.projectId === shownProjectId ? 'project' : 'global';
}

/** Links keep agent detail addressable; ordinary activation can open its requests in place. */
export function sidebarAgentRoute(projectId: string, agent: { id: string; waiting?: boolean; queued?: boolean }): Route {
  return projectRoute(projectId, 'agents', agent.queued ? null : agent.id);
}
