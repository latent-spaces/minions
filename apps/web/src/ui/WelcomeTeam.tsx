import { useEffect, useRef, useState } from 'react';
import { CharacterAvatar } from './CharacterAvatar';
import { characterSource } from './character-set';
import { drawTubeConnector } from './communication-map/tube-connector';
import './welcome.css';

const TEAM = ['fox', 'cat', 'bear', 'dog', 'panda'] as const;
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

/** The map's rubber tube and bead on an arc behind the welcome avatars and caption. */
function WelcomeConnection({ from, to }: { from: number; to: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const raster = canvas.current!, team = raster.parentElement!, drawing = raster.getContext('2d');
    if (!drawing) return;
    const started = performance.now();
    let frame = 0, visible = false;
    const draw = () => {
      const box = raster.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
      const width = Math.round(box.width * ratio), height = Math.round(box.height * ratio);
      if (raster.width !== width) raster.width = width;
      if (raster.height !== height) raster.height = height;
      drawing.setTransform(ratio, 0, 0, ratio, 0, 0); drawing.clearRect(0, 0, box.width, box.height);
      const faces = team.querySelectorAll('.k42-character-avatar');
      const a = faces[from]?.getBoundingClientRect(), b = faces[to]?.getBoundingClientRect();
      if (a && b && box.width && box.height) {
        const elapsed = performance.now() - started, progress = Math.min(1, elapsed / 1200);
        // Move quickly at the ends and linger over the crest without stopping abruptly.
        const phase = progress + .4 * Math.sin(2 * Math.PI * progress) / (2 * Math.PI);
        const sx = a.left + a.width / 2 - box.left, tx = b.left + b.width / 2 - box.left;
        drawing.globalAlpha = 1;
        const height = Math.max(28, Math.min(48, Math.abs(tx - sx) * .2));
        drawTubeConnector(drawing, sx, a.top + a.height / 2 - box.top, tx, b.top + b.height / 2 - box.top,
          progress < 1 ? [phase] : [], '#211b27', 'rubber', {
            bend: sx < tx ? -height : height, lineOpacity: .18 * Math.min(1, elapsed / 120), beadScale: 2.5, beadColor: '#141414',
          });
      }
      if (visible) frame = requestAnimationFrame(draw);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting; cancelAnimationFrame(frame);
      if (visible) draw();
    });
    observer.observe(raster);
    return () => { visible = false; cancelAnimationFrame(frame); observer.disconnect(); };
  }, [from, to]);
  return <canvas ref={canvas} className="k42-welcome-connection" />;
}

/** Five illustrative agents extend the shared avatars with welcome-only lift, scale and message effects.
 * Blinking and occasional gaze remain owned by CharacterAvatar.
 * The conversation is synthetic; these are not running agents. */
export function WelcomeTeam() {
  const [step, setStep] = useState(0), [still] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => { if (still) return; const timer = setInterval(() => setStep(n => (n + 1) % STORY.length), STEP_MS); return () => clearInterval(timer); }, [still]);
  const line = STORY[step];
  return <div className="k42-welcome-swarm" aria-hidden="true">
    <span key={step} className="k42-swarm-line">{line.text}</span>
    <div className="k42-welcome-team">
      {TEAM.map((character, index) => <span key={character} className={`k42-welcome-face${index === line.to ? ' is-active' : ''}${index === line.from ? ' is-sending' : ''}`} data-character-motion-root=""><CharacterAvatar character={character} src={characterSource(character)} animationKey={`welcome:${character}`} state="idle" /></span>)}
      {line.from !== null && !still && <WelcomeConnection key={step} from={line.from} to={line.to} />}
    </div>
  </div>;
}
