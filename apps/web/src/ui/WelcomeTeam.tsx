import { useEffect, useRef } from 'react';
import { characterAtlas } from './character-assets';
import './welcome.css';

const TEAM = ['cat', 'bear', 'dog'] as const;
const FORWARD = 4;

// The direction sheets are 3×3 grids: cell 4 faces forward, the others look toward their position in the grid.
const place = (face: HTMLElement, cell: number) => { face.style.backgroundPosition = `${(cell % 3) * 50}% ${Math.floor(cell / 3) * 50}%`; };

/** Three of the app's characters on the first-run welcome; their heads follow the pointer (owner, 16 November 2026). Decorative only. */
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
  return <div className="k42-welcome-team" ref={root} aria-hidden="true">
    {TEAM.map(character => <span key={character} className="k42-welcome-face" style={{ backgroundImage: `url(${characterAtlas(character, 'directions')})` }} />)}
  </div>;
}
