import type React from 'react';
import { useEffect, useState } from 'react';
import { CharacterAvatar } from './CharacterAvatar';
import { characterSource } from './character-set';
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
      {line.from !== null && !still && <span key={`m${step}`} className="k42-swarm-message" style={{ '--from': line.from, '--to': line.to } as React.CSSProperties} />}
    </div>
  </div>;
}
