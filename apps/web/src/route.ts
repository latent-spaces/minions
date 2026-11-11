// App locations live in the query string: the app is served statically at the root with no fallback route,
// so a path per screen would not survive a reload. No parameters means My projects.
export const SECTIONS = ['overview', 'preview', 'usage', 'teams', 'agents', 'conversations', 'control-center', 'needs-you'] as const;
export type Section = typeof SECTIONS[number];
export const GLOBAL_VIEWS = ['projects', 'computers', 'needs-you'] as const;
export type GlobalView = typeof GLOBAL_VIEWS[number];
export const CONTROL_CENTER_SECTIONS = ['status', 'merging', 'repository', 'agents', 'features'] as const;
export type ControlCenterSection = typeof CONTROL_CENTER_SECTIONS[number];
export type Route =
  | { view: GlobalView; projectList?: 'archived' }
  | { view: 'project'; projectId: string; section: Section; thread: string | null; agent: string | null; q: string | null; agentFilter?: 'all'; message?: string; controlSection?: ControlCenterSection;
    /** Tasks section: the open task page (owner decision, 11 November 2026). */
    task?: string };

export const validProjectId = (id: string) => /^[a-f0-9]{64}$/.test(id);
// Agents owns the directory and agent details. Its default filter is My agents;
// All agents keeps its name search and filter in links, reloads and Back/Forward.
export const projectRoute = (projectId: string, section: Section = 'overview', agent: string | null = null, q: string | null = null, agentFilter: 'mine' | 'all' = 'mine'): Route =>
  ({ view: 'project', projectId, section, thread: null, agent: section === 'agents' ? agent : null, q: section === 'agents' && q ? q : null,
    ...(section === 'agents' && (agentFilter === 'all' || q) ? { agentFilter: 'all' as const } : {}) });
export const taskRoute = (projectId: string, taskId: string): Route =>
  ({ view: 'project', projectId, section: 'overview', thread: null, agent: null, q: null, task: taskId });
export const controlCenterRoute = (projectId: string, category?: ControlCenterSection): Route =>
  ({ view: 'project', projectId, section: 'control-center', thread: null, agent: null, q: null, ...(category ? { controlSection: category } : {}) });
export const validPairingId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
export const ownerApprovalRequest = (search: string): string | null => {
  const query = new URLSearchParams(search), request = query.get('request');
  return query.get('view') === 'owner-connect' && request && validPairingId(request) ? request : null;
};
const validId = (id: string) => /^[\w-]{1,200}$/.test(id);
// The service searches by up to 40 characters of a name.
const validSearch = (q: string) => q.length > 0 && q.length <= 40;

export function parseRoute(search: string): Route {
  const query = new URLSearchParams(search);
  const projectId = query.get('project');
  if (projectId !== null) {
    // URL parameters must never become arbitrary authenticated API path segments.
    if (!validProjectId(projectId)) return { view: 'projects' };
    const requested = query.get('section');
    const asked = requested as Section | null;
    const section = asked && (SECTIONS.includes(asked as typeof SECTIONS[number])) ? asked as Section : 'overview';
    const thread = query.get('thread'), agent = query.get('agent'), q = query.get('q');
    return { view: 'project', projectId, section, thread: section === 'conversations' && thread && validId(thread) ? thread : null,
      agent: section === 'agents' && agent && validId(agent) ? agent : null, q: section === 'agents' && q && validSearch(q) ? q : null,
      ...(section === 'conversations' && validId(query.get('message') ?? '') ? { message: query.get('message')! } : {}),
      ...(section === 'control-center' && CONTROL_CENTER_SECTIONS.includes(query.get('tab') as ControlCenterSection) ? { controlSection: query.get('tab') as ControlCenterSection } : {}),
      ...(section === 'agents' && (query.get('filter') === 'all' || q && validSearch(q)) ? { agentFilter: 'all' as const } : {}),
      ...(section === 'overview' && validId(query.get('task') ?? '') ? { task: query.get('task')! } : {}) };
  }
  const view = query.get('view') as GlobalView | null;
  const selected = view && GLOBAL_VIEWS.includes(view) ? view : 'projects';
  return { view: selected, ...(selected === 'projects' && query.get('list') === 'archived' ? { projectList: 'archived' as const } : {}) };
}

export function formatRoute(route: Route): string {
  if (route.view !== 'project') {
    const query = new URLSearchParams({ view: route.view });
    if (route.view === 'projects' && route.projectList === 'archived') query.set('list', 'archived');
    return `?${query}`;
  }
  const query = new URLSearchParams({ project: route.projectId });
  if (route.section !== 'overview') query.set('section', route.section);
  if (route.thread) query.set('thread', route.thread);
  if (route.message && route.section === 'conversations' && validId(route.message)) query.set('message', route.message);
  if (route.agent) query.set('agent', route.agent);
  if (route.q) query.set('q', route.q);
  if (route.section === 'agents' && route.agentFilter === 'all') query.set('filter', 'all');
  if (route.section === 'overview' && route.task && validId(route.task)) query.set('task', route.task);
  if (route.section === 'control-center' && route.controlSection && CONTROL_CENTER_SECTIONS.includes(route.controlSection)) query.set('tab', route.controlSection);
  return `?${query}`;
}

// Surfaces that keep an uncertain write for an exact retry hold the project open: leaving it
// unmounts them and discards that retry, so a project change asks first. Reloading or leaving the
// viewer discards it too, so the browser's own leave prompt is armed while anything is held.
const holds = new Set<symbol>();
const warn = (event: BeforeUnloadEvent) => event.preventDefault();
export function hold(): () => void {
  const token = Symbol('hold');
  if (holds.size === 0) window.addEventListener('beforeunload', warn);
  holds.add(token);
  return () => { holds.delete(token); if (holds.size === 0) window.removeEventListener('beforeunload', warn); };
}
export const mayLeaveProject = () => holds.size === 0
  || window.confirm('You have unsaved changes or an action waiting for an exact retry. Leave this screen and discard them?');
