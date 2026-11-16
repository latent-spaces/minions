import { NewProjectDialog, type Created } from './NewProjectDialog';
import { useEffect, useState } from 'react';
import { ArrowRight, Eye, Sparkle, Users, Zap } from './icons';
import { SwarmStage, type SwarmScene } from './SwarmStage';
import { BrandLogo } from './BrandLogo';
import './welcome.css';
import './first-project.css';

// The first run, in two pages (owner, 16 November 2026): one card to start, then an idea field and the prompt to copy into a
// new Claude Code or Codex chat. Projects are created from a coding chat (owner, 10 November 2026), not from this app.


// The tour's words: the three messages chosen for Minions; the last one carries the start button (owner, 16 November 2026).
const TOUR = [
  { icon: Zap, title: 'Hard problems, solved faster', text: 'Several agents attack the problem at once, while you just steer.' },
  { icon: Users, title: 'They organize themselves', text: 'Give them the problem. They split the work and pick their own roles.' },
  { icon: Eye, title: 'Always see what’s happening', text: 'Updates, previews and a live map, so you follow along without reading every message.' },
];
export function FirstProject({ created, onWaiting, onOpenProject, onDone, onSkip }: { created: Created; onWaiting: (waiting: boolean) => void; onOpenProject: (id: string) => void; onDone: () => void; /** Leaves the tour, on the first run too (review of PR 68, 16 November 2026). */ onSkip?: () => void }) {
  const [tour, setTour] = useState(0);
  // Opening: the name sits in the middle of the white half, then moves up and the tour appears (owner, 16 November 2026).
  const [intro, setIntro] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => { if (!intro) return; const timer = setTimeout(() => setIntro(false), 2200); return () => clearTimeout(timer); }, [intro]);
  // The slides move on by themselves until the person takes over (owner, 16 November 2026).
  const [auto, setAuto] = useState(true);
  useEffect(() => { if (intro || !auto || tour >= TOUR.length - 1) return; const timer = setTimeout(() => setTour(n => n + 1), 7000); return () => clearTimeout(timer); }, [intro, auto, tour]);
  const go = (next: number) => { setAuto(false); setTour(next); };
  // When the tour leaves, the side menu slides in where the white half was (owner, 16 November 2026).
  useEffect(() => () => { document.body.classList.add('k42-menu-arrive'); window.setTimeout(() => document.body.classList.remove('k42-menu-arrive'), 700); }, []);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (created) setOpen(true); }, [created]);
  // Page one: a single card, with a small terminal showing where the prompt goes (owner, 16 November 2026).
  // A short tour, split in two: words on a white left half, the live swarm on the right (owner, 16 November 2026).
  const slide = TOUR[tour], last = tour === TOUR.length - 1;
  return <section className="k42-first k42-tour" aria-labelledby="k42-first-title">
    <div className={`k42-tour-text${intro ? ' is-intro' : ''}`}>
      {/* The name and what it is, at the top of the tour; the menu with its logo is hidden here (owner, 16 November 2026). */}
      <header className="k42-tour-brand"><BrandLogo /><p>Your own little swarm of coding agents</p></header>
      {onSkip && <button type="button" className="k42-tour-skip" onClick={onSkip}>Skip<ArrowRight size={14} aria-hidden="true" /></button>}
      <span className="k42-tour-step">{tour + 1} / {TOUR.length}</span>
      <span key={tour} className="k42-tour-icon" aria-hidden="true"><slide.icon size={22} /></span>
      <h2 id="k42-first-title" key={`t${tour}`}>{slide.title}</h2>
      <p key={`p${tour}`}>{slide.text}</p>
      <div className="k42-tour-nav">
        {tour > 0 && <button type="button" className="k42-tour-back" onClick={() => go(tour - 1)}>Back</button>}
        {last ? <><button type="button" className="primary k42-tour-next" onClick={() => setOpen(true)}><Sparkle size={16} aria-hidden="true" />Build a new project</button></>
          : <button type="button" className="primary k42-tour-next" onClick={() => go(tour + 1)}>Next<ArrowRight size={16} aria-hidden="true" /></button>}
      </div>
      <div className="k42-tour-dots" role="group" aria-label="Tour steps">{TOUR.map((step, i) => <button key={step.title} type="button" aria-label={`Step ${i + 1}: ${step.title}`} aria-current={i === tour ? 'step' : undefined} onClick={() => go(i)} />)}</div>
    </div>
    <div className="k42-tour-art"><SwarmStage scene={(intro ? 0 : tour) as SwarmScene} /></div>
    {/* The second step opens as a popup over the first (owner, 16 November 2026). */}
    <NewProjectDialog open={open || !!created} created={created} onWaiting={onWaiting} onOpenProject={onOpenProject} onClose={() => { setOpen(false); if (created) onDone(); }} />
  </section>;
}
