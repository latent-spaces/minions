import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
import type { AgentObservation } from '@mlswarm/contracts';
import { AgentObservationList } from '../../apps/web/src/ui/AgentObservationList';
import { workerAgentStatus } from '../../apps/web/src/ui/agent-running-state';
const at = 1_000_000;
const agent = (): AgentObservation => ({ agentId: 'a', agentName: 'Scout', focus: { text: '<script>Checking README</script>', updatedAt: at - 60_000 },
  worker: { session: { missionId: 'm', phase: 'working', deadlineAt: at + 300_000, lastContactAt: at } },
  backgroundControl: { missionId: 'm', state: 'running', deadlineAt: at + 300_000, deviceLastSeenAt: at }, run: { state: 'working', waitingFor: null } });
const render = (row = agent(), now = at) => renderToStaticMarkup(createElement(AgentObservationList, { agents: [row], queued: [], now }));
test('project Pause feedback overrides stale Working observations without offering an individual Resume', () => {
  const row=agent(); row.projectPause={revision:3,requestedAt:at,confirmedAt:null,externalChat:false};
  expect(workerAgentStatus(row,at).label).toBe('Pausing');
  // In contact and still in its turn, it stays Pausing past 30 s while the turn finishes; out of contact it is unconfirmed.
  row.worker.session!.lastContactAt=at+60000;
  expect(workerAgentStatus(row,at+60000)).toMatchObject({label:'Pausing',title:'Project Pause requested. Finishing its current turn, then it pauses.'});
  expect(workerAgentStatus(row,at+150000).label).toBe('Pause unconfirmed');
  row.worker.session!.phase='waiting';
  expect(workerAgentStatus(row,at+60000).label).toBe('Pause unconfirmed');
  row.worker.session!.phase='working';row.worker.session!.lastContactAt=at;
  row.projectPause.confirmedAt=at;
  expect(workerAgentStatus(row,at).label).toBe('Paused');
  expect(workerAgentStatus(row,at+90000).label).toBe('Pause unconfirmed');
  row.projectPause.confirmedAt=null;row.projectPause.externalChat=true;
  expect(workerAgentStatus(row,at).label).toBe('Pause unconfirmed');
  row.backgroundControl!.state='stopped';expect(workerAgentStatus(row,at).label).toBe('Stopped');
});
test('shared rows are observation only, escape reported focus and count the time left using the observation clock', () => {
  const html = render(); expect(html).toContain('Working'); expect(html).toContain('5 min left'); expect(html).toContain('Last reported focus:');
  expect(html).toContain('&lt;script&gt;Checking README&lt;/script&gt;'); expect(html).not.toContain('<button'); expect(html).not.toContain('<a ');
  expect(html).toContain('Updated 1 min ago'); expect(render(agent(), at + 60_000)).toContain('4 min left');
});
test('terminal observations beat intake state; offline is never Working', () => {
  const row = agent(); row.backgroundControl!.state = 'stopped';
  expect(workerAgentStatus(row, at).label).toBe('Stopped'); expect(render(row)).toContain('Stopped'); expect(render(row)).not.toContain('min left');
  row.backgroundControl!.state = 'running'; row.backgroundControl!.deviceLastSeenAt = at - 90_000; row.worker.session!.lastContactAt = at - 90_000;
  expect(workerAgentStatus(row, at).label).toBe('Offline'); expect(render(row)).toContain('Current activity is unconfirmed');
  row.backgroundControl!.state = 'recovery_required'; expect(workerAgentStatus(row, at).label).toBe('Recovery');
});
test('mismatched, queued and paused work retain existing status rules; past the end time an agent finishes its turn, then waits', () => {
  const row = agent(); row.backgroundControl!.missionId = 'other'; expect(workerAgentStatus(row, at).label).toBe('Unknown');
  row.run = { state: 'pending', waitingFor: 'project' }; expect(render(row)).toContain('Waiting for the owner'); expect(render(row)).not.toContain('min left');
  row.run = null; row.backgroundControl!.missionId = 'm';
  row.worker.session!.lastContactAt = row.backgroundControl!.deviceLastSeenAt = at + 300_000;
  const late = render(row, at + 300_000); expect(late).toContain('Working'); expect(late).toContain('Past the end time, finishing its turn'); expect(late).not.toContain('min left'); expect(late).not.toContain('Stopping');
  row.backgroundControl!.state = 'waiting'; expect(render(row, at + 300_000)).toContain('Time is up. Waiting for more time'); row.backgroundControl!.state = 'running';
  row.worker.session!.lastContactAt = row.backgroundControl!.deviceLastSeenAt = at;
  const queued = renderToStaticMarkup(createElement(AgentObservationList, { agents: [], queued: [{ id: 'q', name: 'Queued', waitingFor: 'time' }], now: at })); expect(queued).toContain('Waiting for more time.');
  row.backgroundControl!.state = 'paused'; expect(render(row)).toContain('Paused'); expect(render(row)).toContain('5 min left');
  row.focus = null; expect(render(row)).toContain('No focus reported yet');
});
