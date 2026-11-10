// Opt-in local acceptance at the real 15s cadence. Config: .scale-artifacts/cadence-config.json {"pin":"source SHA"}.
// Counts fixture, bootstrap, authority/dependency, writer, replay, retry, recovery, and listener work separately.
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { agents, inProject, db } from '../src/firestore.js';
import { runnerUsage, presence } from '../src/v2/records.js';
import { reportTurn } from '../src/v2/turn-reports.js';
import { prepareUsageProgress } from '../src/v2/usage-progress.js';
import { projectUsageStats, stopProjectUsage } from '../src/view/project-usage.js';
import { transportCause } from '../../../tools/benchmarks/loadgen-transport.js';
import { startRun } from '../src/v2/runs.js';
import { reportAgentFocus } from '../src/projects/agent-focus.js';
import { writeCreatedAgentStatus } from '../src/v2/agent-group.js';
import { prepareCurrentStateProgress } from '../src/view/current-state-progress.js';
import { configureCurrentState, currentStateStats, stopCurrentState } from '../src/view/current-state.js';
import { instrumentFirestoreWork, meter, work, difference } from './firestore-work-meter.js';
import { viewRoutes } from '../src/view/routes.js';
import { resetEmulator, seed, seedApprovedProject, testProject, idTokenFor } from './helpers.js';
const configUrl = new URL('../../../.scale-artifacts/cadence-config.json', import.meta.url);
const config: { pin: string } | null = existsSync(configUrl) ? JSON.parse(readFileSync(configUrl, 'utf8')) : null;
const HOT = 'e'.repeat(64), small = Array.from({ length: 100 }, (_, n) => n.toString(16).padStart(64, '0'));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const cpuMs = (value: NodeJS.CpuUsage) => (value.user + value.system) / 1000;
const rowId = (n: number) => `row-${String(n).padStart(5, '0')}`;

test.skipIf(!config)('5000 agents at 15s: quiet and busy canonical writers, 1/4 viewers, hot project after 100 projects', async () => {
  stopCurrentState();
  const restoreMeter = instrumentFirestoreWork(), fixture = work();
  const memberIds: string[] = [], memberTokens: string[] = []; let viewerTokens: string[] = [];
  const runIds = new Map<string, string>(); let owner = '', token = '', base = '';
  let server: Server | undefined, activeHot = work(), activeSmall = work(), activeUsage = work();
  try {
    await meter.run(fixture, async () => {
      // Include the disposable admission receipt write in fixture work, not just request reads.
      await resetEmulator();
      const f = await seed({ profiles: [{ name: 'Cadence owner', email: 'cadence-owner@example.test' },
        ...Array.from({ length: 4 }, (_, n) => ({ name: `Viewer ${n}`, email: `cadence-viewer-${n}@example.test` }))] });
      memberIds.push(...f.personIds.slice(1));
      owner = f.personIds[0]!;
      for (const project of [...small, HOT]) {
        await seedApprovedProject(project, { ownerProfileId: owner, required: false,
          definition: { title: 'Synthetic cadence project', goal: 'Validate canonical status', beneficiaries: 'Tests', output: 'Evidence',
            scope: 'Disposable emulator', acceptanceCriteria: 'All reads/writes counted', sources: null, resources: null, mergeApproval: 'humans' },
          runtime: { ...testProject, revision: 0, configuredAt: 0, configuredBy: owner, setupFinalizedAt: 0 } });
        await inProject(project, async () => {
          const total = project === HOT ? 5000 : 5;
          for (let start = 0; start < total; start += 75) await db.runTransaction(async tx => {
            const ids = Array.from({ length: Math.min(75, total - start) }, (_, n) => rowId(start + n));
            const progress = await prepareCurrentStateProgress(tx, ids.map(id => presence().doc(id)));
            const usageProgress = await prepareUsageProgress(tx, ids);
            for (const id of ids) {
              usageProgress(id, 'created');
              const agent = { name: id, ownerProfileId: owner, connectionEpoch: 0, revokedAt: null, tokenHash: 'synthetic', createdAt: 1, tokenIssuedAt: null };
              tx.set(agents().doc(id), agent);
              writeCreatedAgentStatus(tx, presence().doc(id), agent, progress);
              // Historical totals remain unaggregated; cold reads must preserve all of them.
              tx.set(runnerUsage().doc(id), { turns: 1, input: 20, output: 5, cacheRead: 3, cacheWrite: 2,
                tokenCoverage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
                inputSemantics: id === rowId(0) ? 'mixed' : 'uncached', lastReportedAt: 1 } as never);
            }
          });
        });
      }
      for (const profileId of memberIds) {
        const membership = { profileId, projectId: HOT, role: 'member', status: 'active', connectionEpoch: 0, statusChangedAt: 0,
          restrictions: { chatMutedUntil: null }, revision: 1, updatedAt: 0 };
        await db.doc(`projects/${HOT}/members/${profileId}`).set(membership);
        await db.doc(`profiles/${profileId}/memberships/${HOT}`).set(membership);
      }
      // Real run writers establish 50 currently executable identities. No model or worker process is started.
      await inProject(HOT, async () => {
        for (let n = 0; n < 50; n++) {
          const id = rowId(n), run = await startRun(id, { clientRunId: randomUUID(), runnerVersion: 'cadence-synthetic-no-model', takeover: false }, Date.now);
          runIds.set(id, run.run_id);
        }
      });
    });
    token = await idTokenFor('cadence-owner@example.test');
    for (let n = 0; n < 4; n++) memberTokens.push(await idTokenFor(`cadence-viewer-${n}@example.test`));
    const app = express(), router = viewRoutes(Date.now);
    app.use('/p/:projectId', (req, res, next) => {
      const project = req.params.projectId;
      return meter.run(project === HOT ? req.url.startsWith('/usage') ? activeUsage : activeHot : activeSmall,
        () => inProject(project, () => router(req, res, next)));
    });
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const viewers of [1, 4]) {
      viewerTokens = viewers === 1 ? [token] : memberTokens;
      stopCurrentState(); stopProjectUsage(); const restore = configureCurrentState({});
      const hotWork = work(), usageWork = work(), smallWork = work(), writerWork = work();
      activeHot = hotWork; activeSmall = smallWork; activeUsage = usageWork;
      let offered = 0, completed = 0, errors = 0, peakHeap = 0, peakRss = 0;
      const failures: object[] = []; let accepted = false; let phase = 'bootstrap';
      let bootstrap: object | undefined; const phases: object[] = [];
      const sample = () => { const memory = process.memoryUsage(); peakHeap = Math.max(peakHeap, memory.heapUsed); peakRss = Math.max(peakRss, memory.rss); };
      const sampling = setInterval(sample, 25); sample();
      const drain = async (project: string, viewer: number, cursor?: string) => {
        let next = cursor; const rows = [];
        for (let pages = 0; pages < 30; pages++) {
          offered++;
          let status: number | undefined; const began = performance.now(); let transport: 'request' | 'body' = 'request';
          try {
            const response = await fetch(`${base}/p/${project}/communication/agents/current${next ? '?cursor=' + encodeURIComponent(next) : ''}`,
              { headers: { authorization: `Bearer ${project === HOT ? viewerTokens[viewer] : token}` }, signal: AbortSignal.timeout(10_000) });
            status = response.status; transport = 'body'; expect(response.status).toBe(200);
            const answer = await response.json() as import('../src/view/current-state.js').CurrentStateAnswer;
            completed++; rows.push(...answer.rows);
            expect(answer.notReady).toBe(false); next = answer.cursor;
            if (answer.complete) return { answer, rows };
          } catch (error) { errors++; if (failures.length < 20) failures.push({ phase, project: project.slice(-8), viewer, page: pages, elapsedMs: performance.now() - began, status, cause: transportCause(error, transport), memory: process.memoryUsage() }); throw error; }
        }
        throw new Error('A canonical page chain failed to complete.');
      };
      const readUsage = async (project: string, viewer: number) => {
        offered++; let status: number | undefined; const began = performance.now(); let transport: 'request' | 'body' = 'request';
        try {
          const response = await fetch(`${base}/p/${project}/usage`, { headers: { authorization: `Bearer ${project === HOT ? viewerTokens[viewer] : token}` }, signal: AbortSignal.timeout(10_000) });
          status = response.status; transport = 'body'; expect(response.status).toBe(200);
          const value = await response.json() as import('@mlswarm/contracts').ProjectUsage;
          completed++; return value;
        } catch (error) {
          errors++; if (failures.length < 20) failures.push({ phase, project: project.slice(-8), viewer, endpoint: 'usage', elapsedMs: performance.now() - began, status, cause: transportCause(error, transport), memory: process.memoryUsage() });
          throw error;
        }
      };
      try {
        const smallCursors = new Map<string, string>();
        for (const project of small) { smallCursors.set(project, (await drain(project, 0)).answer.cursor); await readUsage(project, 0); }
        const hotCursors: string[] = []; let baselineReports = 0;
        for (let viewer = 0; viewer < viewers; viewer++) {
          const head = await drain(HOT, viewer);
          expect(head.rows).toHaveLength(5000);
          expect(new Set(head.rows.map(row => row.id)).size).toBe(5000);
          expect(head.rows.every(row => !('removed' in row))).toBe(true);
          hotCursors.push(head.answer.cursor);
          const usage = await readUsage(HOT, viewer); baselineReports = usage.reports;
          expect(usage.agents).toBe(5000); expect(usage.reports).toBeGreaterThanOrEqual(5000);
        }
        bootstrap = { hot: { ...hotWork }, usage: { ...usageWork }, small: { ...smallWork }, stats: currentStateStats(), usageStats: projectUsageStats() };
        for (const kind of ['quiet', 'busy'] as const) {
          phase = kind; const beforeUsage = { ...usageWork }, usageBefore = projectUsageStats();
          const beforeHot = { ...hotWork }, beforeSmall = { ...smallWork }, beforeWriter = { ...writerWork }, before = currentStateStats();
          const started = performance.now(), cpu = process.cpuUsage();
          if (kind === 'quiet') await sleep(15_000);
          else {
            // Fifty real focus operations across ten rounds. Same-shard conflicts and their reads/retries count.
            for (let round = 0; round < 10; round++) {
              const target = started + (round + 1) * 1000;
              await sleep(Math.max(1, target - performance.now()));
              await meter.run(writerWork, () => inProject(HOT, () => Promise.all(Array.from({ length: 5 }, async (_, k) => {
                const n = round * 5 + k, id = rowId(n);
                await reportAgentFocus(id, runIds.get(id)!, { status: `busy-${viewers}-${n}`, client_request_id: `cadence-${viewers}-${n}` }, Date.now);
                await reportTurn(id, runIds.get(id)!, { kind: 'synthetic', outcome: 'succeeded', endedAt: Date.now(),
                  usage: { sequence: viewers, model: 'synthetic-no-model', seconds: 1, inputSemantics: 'uncached',
                    tokens: { input: 20, output: 5, cacheRead: 3, cacheWrite: 2, modelCalls: 1 } } }, Date.now);
              }))));
            }
            await sleep(Math.max(1, started + 15_000 - performance.now()));
          }
          const pollAtMs = performance.now() - started;
          const otherPolls = small.map(async project => {
            smallCursors.set(project, (await drain(project, 0, smallCursors.get(project))).answer.cursor);
            await readUsage(project, 0);
          });
          const [answers] = await Promise.all([Promise.all(hotCursors.map((cursor, i) => drain(HOT, i, cursor))), Promise.all(otherPolls)]);
          answers.forEach((answer, n) => { hotCursors[n] = answer.answer.cursor; });
          if (kind === 'busy') for (const answer of answers) for (let n = 0; n < 50; n++) expect(answer.rows)
            .toContainEqual(expect.objectContaining({ id: rowId(n), focus: { text: `busy-${viewers}-${n}`, updatedAt: expect.any(Number) } }));
          const usageAnswers = await Promise.all(hotCursors.map((_, i) => readUsage(HOT, i)));
          expect(usageAnswers.every(a => a.reports === baselineReports + (kind === 'busy' ? 50 : 0))).toBe(true);
          expect(projectUsageStats().seeds).toBe(usageBefore.seeds);
          if (kind === 'quiet') expect(projectUsageStats().headReads).toBe(usageBefore.headReads);
          const after = currentStateStats();
          expect(after.canonicalReads).toBe(before.canonicalReads);
          expect(after.listeners).toBe(0); expect(after.oneShots).toBe(before.oneShots);
          if (kind === 'quiet') expect(after.rowDocs).toBe(before.rowDocs);
          phases.push({ kind, pollAtMs, wallMs: performance.now() - started, cpuMs: cpuMs(process.cpuUsage(cpu)),
            hot: difference(hotWork, beforeHot), usage: difference(usageWork, beforeUsage), small: difference(smallWork, beforeSmall), writers: difference(writerWork, beforeWriter), usageStats: projectUsageStats(),
            stats: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key as keyof typeof before]])) });
        }
        expect(errors).toBe(0); expect(completed).toBe(offered); accepted = true;
      } finally {
        clearInterval(sampling);
        console.info('CURRENT_STATE_CADENCE', JSON.stringify({ pin: config!.pin, node: process.version, viewers,
          shape: 'HTTP/Auth: status AND usage, 100x5 then 5000 agents; 50 focus and 50 usage reports per busy interval', ownerCount: 1, viewerIdentities: viewers, bootstrapRowsPerViewer: 5000,
          fixture, bootstrap, phases, totals: { hot: hotWork, usage: usageWork, small: smallWork, writers: writerWork },
          offered, completed, accepted, errors, failures, peakHeap, peakRss,
          note: 'Logical SDK work incl retries and receipt; historical totals retained without backfill; Node server+driver only, not JVM/billing/native Windows/managed capacity.' }));
        restore(); stopCurrentState(); stopProjectUsage();
      }
    }
  } catch (error) {
    console.info('CUTOVER_WORKLOAD_FAILURE', JSON.stringify({ pin: config!.pin, cause: transportCause(error, 'request'), fixture, hot: activeHot, usage: activeUsage, small: activeSmall, memory: process.memoryUsage() }));
    throw error;
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    restoreMeter(); stopCurrentState(); stopProjectUsage();
  }
}, 240_000);
