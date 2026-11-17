import { isPrivateProject } from './schema.js';
import type { Transaction } from '../firestore.js';
import { currentProjectId } from '../firestore.js';
import { Refusal } from '../errors.js';
import { projects, runtimeOf } from './records.js';
import { projectListings } from './catalog.js';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/schema.js';

/** Public project metadata requires current publication, not merely a known project ID. */
export async function assertPublicProject(tx: Transaction) {
  const id = currentProjectId();
  const [project, listing] = await Promise.all([tx.get(projects.doc(id)), tx.get(projectListings.doc(id))]);
  const record = project.data(), runtime = runtimeOf(record);
  if (!record || isPrivateProject(record) || !record.publication.listed || record.workspaceId !== DEFAULT_WORKSPACE_ID || !listing.exists
    || listing.data()?.workspaceId !== DEFAULT_WORKSPACE_ID || !runtime || record.setup.required && !runtime.setupFinalizedAt)
    throw new Refusal('not_found', 'This project isn’t published to Explore.');
  return record;
}
