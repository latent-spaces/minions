import fox from './assets/agents/families/fox-1.webp';
import turtle from './assets/agents/families/turtle-1.webp';
import seal from './assets/agents/families/seal-1.webp';
import parrot from './assets/agents/families/parrot-1.webp';
import owl from './assets/agents/families/owl-1.webp';
import penguin from './assets/agents/families/penguin-1.webp';
import cat from './assets/agents/families/cat-1.webp';
import rabbit from './assets/agents/families/rabbit-1.webp';
import bear from './assets/agents/families/bear-1.webp';
import hedgehog from './assets/agents/families/hedgehog-1.webp';

// A swarm: many agents working together around one shared project, linked by the messages between them.
const SWARM = [fox, owl, seal, parrot, penguin, cat, rabbit, bear, hedgehog, turtle];
const SWARM_LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [5, 6], [6, 7], [7, 8], [8, 9], [9, 5], [0, 5], [1, 6], [2, 7], [3, 8], [4, 9], [0, 2], [6, 9]];
export function TourWelcomePanel() {
  const at = (index: number) => { const ring = index < 5 ? 26 : 42, angle = (index % 5) / 5 * Math.PI * 2 + (index < 5 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / 5); return [50 + ring * Math.cos(angle), 50 + ring * Math.sin(angle)]; };
  return <aside className="k42-split-panel k42-tone-sky" aria-hidden="true"><div className="k42-tour-swarm">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none">{SWARM_LINKS.map(([a, b]) => { const [x1, y1] = at(a), [x2, y2] = at(b); return <line key={`${a}-${b}`} x1={x1} y1={y1} x2={x2} y2={y2} />; })}
      {SWARM.slice(0, 5).map((_, index) => { const [x, y] = at(index); return <line key={`c${index}`} className="is-hub" x1={50} y1={50} x2={x} y2={y} />; })}</svg>
    <span className="k42-tour-swarm-hub">Shared project</span>
    {SWARM.map((image, index) => { const [x, y] = at(index); return <img key={index} src={image} alt="" style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${index * 0.35}s` }} />; })}
  </div></aside>;
}
