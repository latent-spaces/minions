import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { characterSource } from './character-set';
import './swarm-stage.css';

// A decorative, simulated swarm for the first run (owner, 16 November 2026): twenty agents and you, with messages flying
// between them and short popups of what they say. Synthetic only; nothing here reflects real agents or data.
const CAST = ['fox', 'cat', 'bear', 'dog', 'panda', 'owl', 'frog', 'koala', 'rabbit', 'raccoon', 'red-panda', 'tiger',
  'person-robot', 'person-alien', 'fox', 'cat', 'bear', 'owl', 'panda', 'dog'];
// Positions in percent of the stage, spread like a loose cloud around the centre.
const SPOTS: [number, number][] = [[8, 22], [20, 62], [27, 18], [36, 78], [44, 40], [52, 12], [58, 66], [66, 30], [74, 82], [82, 46],
  [92, 20], [90, 74], [14, 86], [6, 52], [32, 48], [70, 56], [48, 86], [62, 8], [78, 12], [24, 34]];
const HUMAN = SPOTS.length; // the person, drawn larger, in the middle
SPOTS.push([50, 46]);
const FLIGHT_MS = 1300;
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

// Each tour slide has its own scene (owner, 16 November 2026):
// 0 parallel work: you hand over a goal and everyone works at once;
// 1 they organize: agents gather into three teams that pick their own jobs;
// 2 you see it all: progress flows to you as updates.
export type SwarmScene = 0 | 1 | 2;
const TEAMS: { name: string; at: [number, number] }[] = [{ name: 'Search', at: [22, 36] }, { name: 'Meal planner', at: [76, 30] }, { name: 'Tests & review', at: [50, 82] }];
const teamOf = (i: number) => i % 3;
function scenePositions(scene: SwarmScene): [number, number][] {
  if (scene === 0) return SPOTS;
  const counts = [0, 0, 0];
  return SPOTS.map((spot, i) => {
    if (i === HUMAN) return scene === 2 ? [50, 44] : spot;
    const team = teamOf(i), n = counts[team]++, ring = n === 0 ? 0 : 1, angle = (n - 1) / 6 * Math.PI * 2;
    const [cx, cy] = TEAMS[team].at;
    return ring === 0 ? [cx, cy] : [cx + Math.cos(angle) * 11, cy + Math.sin(angle) * 17];
  });
}
const WORK = ['Writing the API', 'Building search', 'Styling the cards', 'Writing tests', 'Fixing a bug', 'Adding the planner', 'Setting up the DB', 'Making it mobile'];
const ORGANIZE = ['I’ll lead search', 'I’ll take the UI', 'Splitting this up', 'I can write tests', 'Joining planner', 'You take the API?', 'Deal!'];
const UPDATES = ['Update: search shipped ✓', 'Preview is ready', 'Need your OK to merge', 'Tests pass ✓', 'Planner is half done'];
const GOAL = 'Build me a recipe app';

type Flight = { id: number; from: number; to: number; text: string };
const nearIn = (pos: [number, number][], a: number) => pos.map((spot, i) => ({ i, d: Math.hypot(spot[0] - pos[a][0], (spot[1] - pos[a][1]) * .55) }))
  .filter(item => item.i !== a && item.i !== HUMAN).sort((x, y) => x.d - y.d).slice(0, 3).map(item => item.i);

export function SwarmStage({ scene = 0 }: { scene?: SwarmScene }) {
  const pos = useMemo(() => scenePositions(scene), [scene]);
  const neighbours = useMemo(() => pos.map((_, i) => nearIn(pos, i)), [pos]);
  const [flights, setFlights] = useState<Flight[]>([]), [busy, setBusy] = useState<Set<number>>(new Set()), [bubbles, setBubbles] = useState<{ id: number; at: number; text: string }[]>([]);
  const [still] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    setFlights([]); setBubbles([]); setBusy(new Set());
    if (still) return;
    let id = 0;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(fn, ms)); };
    const pop = (at: number, text: string, ms = 1800) => { const key = ++id; setBubbles(list => [...list.slice(-4), { id: key, at, text }]); later(() => setBubbles(list => list.filter(b => b.id !== key)), ms); };
    const send = (from: number, to: number, text: string) => {
      const flight = { id: ++id, from, to, text };
      setFlights(list => [...list.slice(-8), flight]);
      setBusy(set => new Set(set).add(from));
      later(() => { setFlights(list => list.filter(f => f.id !== flight.id)); pop(to, text); setBusy(set => { const next = new Set(set); next.delete(from); next.add(to); return next; }); }, FLIGHT_MS);
      later(() => setBusy(set => { const next = new Set(set); next.delete(to); return next; }), FLIGHT_MS + 900);
    };
    const agent = () => Math.floor(Math.random() * CAST.length);
    // Scene openers.
    if (scene === 0) { pop(HUMAN, GOAL, 2200); [0, 4, 8, 12, 16].forEach((target, k) => later(() => send(HUMAN, target, 'On it!'), 600 + k * 120)); }
    if (scene === 1) TEAMS.forEach((_, team) => later(() => pop(CAST.findIndex((__, i) => teamOf(i) === team), pick(ORGANIZE)), 900 + team * 300));
    const tick = () => {
      if (scene === 0) { const a = agent(); setBusy(set => new Set(set).add(a)); pop(a, pick(WORK), 1500); later(() => setBusy(set => { const n = new Set(set); n.delete(a); return n; }), 1500); if (Math.random() < .5) { const b = agent(); send(b, pick(neighbours[b]), pick(['Can you review?', 'Pushed a fix', 'Done ✓'])); } }
      if (scene === 1) { const a = agent(); const mates = neighbours[a].filter(n => teamOf(n) === teamOf(a)); send(a, mates.length ? pick(mates) : pick(neighbours[a]), pick(ORGANIZE)); }
      if (scene === 2) { if (Math.random() < .65) send(agent(), HUMAN, pick(UPDATES)); else send(HUMAN, agent(), pick(['Looks great!', 'Yes, go ahead', 'Ship it'])); }
    };
    const timer = window.setInterval(tick, scene === 0 ? 450 : 1000);
    return () => { clearInterval(timer); timers.forEach(clearTimeout); };
  }, [scene, neighbours, still]);
  return <div className={`k42-swarm-stage is-scene-${scene}`} aria-hidden="true">
    {scene > 0 && TEAMS.map(team => <span key={team.name} className="k42-swarm-team" style={{ left: `${team.at[0]}%`, top: `${team.at[1]}%` }}><b>{team.name}</b></span>)}
    <svg className="k42-swarm-links" viewBox="0 0 100 100" preserveAspectRatio="none">
      {pos.flatMap((a, i) => neighbours[i].filter(j => j > i).map(j => <line key={`${i}-${j}`} x1={a[0]} y1={a[1]} x2={pos[j][0]} y2={pos[j][1]} />))}
      {flights.map(f => <line key={`f${f.id}`} className="is-live" x1={pos[f.from][0]} y1={pos[f.from][1]} x2={pos[f.to][0]} y2={pos[f.to][1]} />)}
    </svg>
    {flights.map(f => <span key={f.id} className="k42-swarm-packet" style={{ '--x1': `${pos[f.from][0]}%`, '--y1': `${pos[f.from][1]}%`, '--x2': `${pos[f.to][0]}%`, '--y2': `${pos[f.to][1]}%` } as React.CSSProperties} />)}
    {pos.map(([x, y], i) => <span key={i} className={`k42-swarm-agent${busy.has(i) ? ' is-busy' : ''}${i === HUMAN ? ' is-human' : ''}`} style={{ left: `${x}%`, top: `${y}%` }}>
      <img src={characterSource(i === HUMAN ? 'person-01' : CAST[i])} alt="" />{i === HUMAN && <b>You</b>}
    </span>)}
    {bubbles.map(b => <span key={b.id} className={`k42-swarm-pop${pos[b.at][1] < 30 ? ' is-below' : ''}${b.at === HUMAN ? ' is-you' : ''}`} style={{ left: `${pos[b.at][0]}%`, top: `${pos[b.at][1]}%` }}>{b.text}</span>)}
  </div>;
}
