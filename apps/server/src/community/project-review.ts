import type { Transaction } from '../firestore.js';
import { collection } from '../firestore.js';
import { deriveProjectLifecycle, projectExecution } from '@minions/contracts';
import type { ProjectRecord } from '../projects/records.js';
import { runtimeWithCard } from '../projects/records.js';

// A reviewer observation, never a workspace grant. Explicit fields exclude runtime secrets,
// conversations, agents, connection credentials and owner mutation capabilities.
export async function projectReviewStatus(tx: Transaction, id: string, approved: ProjectRecord) {
  // Card/schema and store depend on proposals; load them only after module initialization.
  const [{ cardDoc, cardDefinition, currentCard }, { setupSnapshot, registeredParticipantCount }] = await Promise.all([
    import('../projects/card.js'), import('../projects/store.js'),
  ]);
  const [card, catalog, participantCount] = await Promise.all([
tx.get(cardDoc(id)),
    tx.get(collection('projectListings').doc(id)), registeredParticipantCount(id, approved.ownerProfileId, tx),
  ]);
  const project = runtimeWithCard(approved, card.data()), current = currentCard(approved, card.data()), setup = setupSnapshot(approved, project);
  const execution = projectExecution(project), listed = catalog.exists;
  const repositoryConfigured = Boolean(project?.repoUrl);
  const state = deriveProjectLifecycle({ kind: 'project', role: 'guest', execution, runtimeStarted: project?.started, listed,
    setupRequired: setup.required, setupFinalizedAt: setup.finalizedAt, minContributors: setup.minContributors, participantCount });
  return { id, definition: cardDefinition(current.definition), cardVersion: current.version, state, execution, listed, setup,
    participantCount, repositoryUrl: project?.repoUrl ?? null, repositoryConfigured };
}
