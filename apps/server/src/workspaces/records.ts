import { validatedCollection } from '../firestore.js';
import { DEFAULT_WORKSPACE_ID, WORKSPACE, type Workspace } from './schema.js';

export { DEFAULT_WORKSPACE_ID, newWorkspaceRecord } from './schema.js';
export const workspaces = validatedCollection<Workspace>('workspaces', value => WORKSPACE.parse(value));
export const workspaceDoc = () => workspaces.doc(DEFAULT_WORKSPACE_ID);
