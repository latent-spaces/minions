import { useEffect, useState } from 'react';
import type { ProjectWorkersView } from '@minions/contracts';
import { projects as projectsApi } from '../api';
import type { SessionUser } from '../session-identity';
import type { Workspace } from '../project-api';
import { Bot, Cpu, Folder, Pulse } from './icons';
import './home-dashboard.css';

const MAX = 12;
const tokensText = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

/** A small dashboard on My projects (owner, 16 November 2026): projects, your agents, how many are working now and the
 * tokens used, read from each project's own workspace and worker views (the first 12 projects). */
export function HomeDashboard({ user, projectIds }: { user: SessionUser; projectIds: string[] }) {
  const [stats, setStats] = useState<{ agents: number; working: number; tokens: number } | null>(null);
  const key = projectIds.slice(0, MAX).join(',');
  useEffect(() => {
    let cancelled = false;
    const ids = key ? key.split(',') : [];
    void Promise.all(ids.map(async id => {
      const [workspace, workers] = await Promise.all([
        projectsApi<Workspace>(user, `/${id}`).catch(() => null),
        projectsApi<ProjectWorkersView>(user, `/${id}/my-workers`).catch(() => null),
      ]);
      const agents = workers?.agents ?? [];
      return { agents: agents.length, working: agents.filter(a => a.backgroundControl?.state === 'running' || a.worker?.session?.phase === 'working').length, tokens: workspace?.tokensUsed ?? 0 };
    })).then(rows => { if (!cancelled) setStats(rows.reduce((sum, row) => ({ agents: sum.agents + row.agents, working: sum.working + row.working, tokens: sum.tokens + row.tokens }), { agents: 0, working: 0, tokens: 0 })); });
    return () => { cancelled = true; };
  }, [user, key]);
  const tiles = [
    { icon: Folder, label: 'Projects', value: String(projectIds.length) },
    { icon: Bot, label: 'Your agents', value: stats ? String(stats.agents) : '–' },
    { icon: Pulse, label: 'Working now', value: stats ? String(stats.working) : '–', live: !!stats?.working },
    { icon: Cpu, label: 'Tokens used', value: stats ? tokensText(stats.tokens) : '–' },
  ];
  return <section className="k42-home-dash" aria-label="Overview">
    {tiles.map(({ icon: Icon, label, value, live }) => <div key={label} className={`k42-home-tile${live ? ' is-live' : ''}`}>
      <span className="k42-home-tile-icon" aria-hidden="true"><Icon size={18} /></span>
      <span className="k42-home-tile-text"><strong>{value}</strong><span>{label}</span></span>
    </div>)}
  </section>;
}
