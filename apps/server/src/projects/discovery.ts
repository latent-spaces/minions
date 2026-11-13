import { isPrivateProject } from './schema.js';
import { projectExecution } from '@mlswarm/contracts';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/schema.js';
// Anonymous discovery exposes only explicitly published, finalized projects. It never joins,
// creates an agent, reads a private transcript or starts a model.
import express, { type Response } from 'express';
import { projects } from '../community/records.js';
import { Refusal, sendRefusal } from '../errors.js';
import { CATALOG_QUERY, readCatalog, readStartingSoon } from './catalog.js';
import { cardDefinition, cardDoc, currentCard } from './card.js';
import { validProjectId } from './access.js';
import { setupSnapshot } from './store.js';
import { runtimeWithCard } from './records.js';
import { artworkOf } from './artwork.js';
import { communityRulesDoc } from './community-schema.js';
import { communityRulesView } from './community-rules.js';

function fail(res: Response, error: unknown) {
  if (error instanceof Refusal) sendRefusal(res, error);
  else {
    console.error('Public project discovery failed.', error);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong loading projects. Try again in a moment.' });
  }
}
const missing = () => new Refusal('not_found', 'This project isn’t published to Explore.');
const needed = (minimum: number | null, count: number | null) => minimum === null || count === null ? null : Math.max(0, minimum - count);

export function projectDiscoveryRoutes(now: () => number) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.status(405).set('Allow', 'GET').json({ error: 'method_not_allowed', message: 'Project discovery is read-only.' }); return; }
    next();
  });
  const answer = (res: Response, read: () => Promise<unknown>) => void read().then(value => res.json(value), error => fail(res, error));
  router.get('/', (req, res) => answer(res, async () => {
    const parsed = CATALOG_QUERY.safeParse(req.query);
    if (!parsed.success || parsed.data.project !== undefined) throw new Refusal('bad_input', 'Use search, category and the cursor returned for those filters.');
    const [page, startingSoon] = await Promise.all([readCatalog(parsed.data, now), readStartingSoon(parsed.data, now)]);
    // A corrupt/orphan listing or an interrupted setup is not a published discovery result.
    // Preserve the scanned-page cursor even when filtering: no unbounded refill query.
    return { ...page, startingSoon, search: { kind: 'title_tag_word_prefix', maxQueryLength: 40 }, projects: page.projects.filter(project => !project.setupPending && project.participantCount !== null)
      .map(project => ({ ...project, contributorsNeeded: needed(project.minContributors, project.participantCount) })) };
  }));
  router.get('/:id', (req, res) => answer(res, async () => {
    const id = req.params.id;
    if (!validProjectId(id)) throw missing();
    if (Object.keys(req.query).length) throw new Refusal('bad_input', 'A project lookup does not accept search filters.');
    const listing = await readCatalog({ project: id }, now), catalog = listing.projects[0];
    if (!catalog || catalog.setupPending || catalog.participantCount === null) throw missing();
    const [approved, card, rules] = await Promise.all([projects.doc(id).get(), cardDoc(id).get(), communityRulesDoc(id).get()]);
    const runtime = runtimeWithCard(approved.data(), card.data());
    if (!approved.exists || isPrivateProject(approved.data()) || !approved.data()!.publication.listed || approved.data()!.workspaceId !== DEFAULT_WORKSPACE_ID
      || !runtime || approved.data()!.setup.required && !runtime.setupFinalizedAt) throw missing();
    const current = currentCard(approved.data()!, card.data());
    return { catalog, card: { version: current.version, definition: cardDefinition(current.definition) },
      project: { name: runtime.name, mission: runtime.mission, rules: runtime.rules, repoUrl: runtime.repoUrl,
        started: runtime.started, paused: runtime.paused, completedAt: runtime.completedAt ?? null, awaitingKickoff: runtime.awaitingKickoff ?? false },
      // Explicit browser Card projection; never spread runtime secrets or identities.
      workspace: { id, role: 'guest', listed: true, state: catalog.state, ...artworkOf(approved.data()!.artwork, catalog.coverImage),
        definition: cardDefinition(current.definition), cardVersion: current.version, communityRules: communityRulesView(rules.data()),
        project: { name: runtime.name, mission: runtime.mission, rules: runtime.rules, repoUrl: runtime.repoUrl, startsAt: runtime.startsAt,
          started: runtime.started, paused: runtime.paused, completedAt: runtime.completedAt ?? null, awaitingKickoff: runtime.awaitingKickoff ?? false },
        revision: runtime.revision ?? 0,
        setup: setupSnapshot(approved.data()!, runtime), participantCount: catalog.participantCount,
        execution: projectExecution(runtime), canConfigure: false },
      contribution: { participantCount: catalog.participantCount, minContributors: catalog.minContributors,
        contributorsNeeded: needed(catalog.minContributors, catalog.participantCount), startDeadline: catalog.startDeadline },
      participantCountSemantics: listing.participantCountSemantics, observedAt: listing.observedAt };
  }));
  router.use((_req, res) => fail(res, missing()));
  return router;
}
