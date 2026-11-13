import { homedir } from 'node:os';
import { join } from 'node:path';
import { configuredWebsiteOrigin, selfHostedWebsiteOrigin } from './website-origin.mjs';
import { siteInstanceId } from './site-state.mjs';

// The fixed layout on a person's computer (owner decision, 11 October 2026). The main agent works in
// main/ and each created agent in its own checkout under projects/<project>/<agent>-<id>/.
// New same-repository agents default to sibling worktrees from a stable base clone (owner, 18 October 2026);
// existing clones stay in place. This module assigns paths; it does not provision Git checkouts. Private credentials
// stay in ~/.mlswarm, outside all of it. <id> is the start of the agent's ID, so two agents never share a
// folder, also when their names differ only by letter case on a disk that ignores it.
export function workspaceHome(env = process.env, userHome = homedir()) {
  configuredWebsiteOrigin(env);
  const site = selfHostedWebsiteOrigin(env), root = join(userHome, 'mlswarm');
  return site === null ? root : join(root, 'instances', siteInstanceId(site));
}
export const layout = root => ({ root, main: join(root, 'main'), projects: join(root, 'projects') });

// Windows refuses to create a folder with a device name such as con or aux, so those get a suffix.
const windowsDeviceName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const slug = name => {
  const readable = String(name ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'project';
  return windowsDeviceName.test(readable) ? `${readable}-project` : readable;
};

// A readable folder for the project. A project already placed on this computer keeps its folder,
// also after a rename; a name another project already uses here gets part of the project ID added.
export function projectFolder(root, projectId, projectName, placed) {
  const projects = layout(root).projects, own = placed.find(p => p.projectId === projectId);
  if (own) return own.folder;
  const readable = join(projects, slug(projectName));
  return placed.some(p => p.folder === readable) ? `${readable}-${projectId.slice(0, 6)}` : readable;
}
