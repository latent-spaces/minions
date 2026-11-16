import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { characterAtlas } from './character-assets';
import './welcome.css';

const TEAM = ['fox', 'cat', 'bear', 'dog', 'panda'] as const;
const FORWARD = 4;
// A generic, simulated swarm: who speaks at each step and what they say (illustrative only, owner 16 November 2026).
const STORY: { from: number | null; to: number; text: string }[] = [
  { from: null, to: 2, text: 'You: “Build me a recipe app”' },
  { from: 2, to: 0, text: 'Bear → Fox: “Can you plan the pages?”' },
  { from: 0, to: 1, text: 'Fox → Cat: “You take search, I’ll do the planner”' },
  { from: 1, to: 3, text: 'Cat → Dog: “Search is ready, can you review?”' },
  { from: 3, to: 4, text: 'Dog → Panda: “Looks good, merging”' },
  { from: 4, to: 2, text: 'Panda: “Posted an update for you ✓”' },
];
const STEP_MS = 2600;

// The direction sheets are 3×3 grids: cell 4 faces forward, the others look toward their position in the grid.
const place = (face: HTMLElement, cell: number) => { face.style.backgroundPosition = `${(cell % 3) * 50}% ${Math.floor(cell / 3) * 50}%`; };

/** Five of the app’s characters acting out a generic swarm: a goal comes in, they message each other and post an update.
 * Their heads follow the pointer (owner, 16 November 2026). Decorative only; synthetic, not live data. */
export function WelcomeTeam() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const faces = [...root.current?.querySelectorAll<HTMLElement>('.k42-welcome-face') ?? []];
    faces.forEach(face => place(face, FORWARD));
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0, x = 0, y = 0;
    const look = () => {
      frame = 0;
      for (const face of faces) {
        const box = face.getBoundingClientRect(), dx = x - (box.left + box.width / 2), dy = y - (box.top + box.height / 2), dead = box.width * .6;
        place(face, (dy < -dead ? 0 : dy > dead ? 6 : 3) + (dx < -dead ? 0 : dx > dead ? 2 : 1));
      }
    };
    const move = (event: PointerEvent) => { x = event.clientX; y = event.clientY; if (!frame) frame = requestAnimationFrame(look); };
    const reset = () => faces.forEach(face => place(face, FORWARD));
    window.addEventListener('pointermove', move);
    document.documentElement.addEventListener('pointerleave', reset);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('pointermove', move); document.documentElement.removeEventListener('pointerleave', reset); };
  }, []);
  const [step, setStep] = useState(0), [still] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => { if (still) return; const timer = setInterval(() => setStep(n => (n + 1) % STORY.length), STEP_MS); return () => clearInterval(timer); }, [still]);
  const line = STORY[step];
  return <div className="k42-welcome-swarm" aria-hidden="true">
    <span key={step} className="k42-swarm-line">{line.text}</span>
    <div className="k42-welcome-team" ref={root}>
      {TEAM.map((character, index) => <span key={character} className={`k42-welcome-face${index === line.to ? ' is-active' : ''}${index === line.from ? ' is-sending' : ''}`} style={{ backgroundImage: `url(${characterAtlas(character, 'directions')})` }} />)}
      {line.from !== null && !still && <span key={`m${step}`} className="k42-swarm-message" style={{ '--from': line.from, '--to': line.to } as React.CSSProperties} />}
    </div>
  </div>;
}
