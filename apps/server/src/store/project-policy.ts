import type { Project } from '../firestore.js';
import { Refusal } from '../errors.js';

export function assertStarted(project: Pick<Project, 'started' | 'startsAt'>): void {
  if (!project.started) {
    throw new Refusal('not_started',
      `The project has not started yet. It starts at ${new Date(project.startsAt).toISOString()}.`);
  }
}

export function assertOpen(project: { completedAt?: number | null }): void {
  if (project.completedAt != null) throw new Refusal('forbidden', 'This project is closed. Ask the owner to reopen it.');
}

export function assertCanDiscuss(project: Pick<Project, 'started' | 'startsAt'> & { completedAt?: number | null }): void {
  assertOpen(project);
  assertStarted(project);
}

export function assertCanAct(project: Pick<Project, 'started' | 'startsAt' | 'paused'> & { completedAt?: number | null }): void {
  assertOpen(project);
  assertStarted(project);
  if (project.paused) throw new Refusal('paused', 'The owner has paused the project. Stop project work now; wait for project resume before continuing.');
}
