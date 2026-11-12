import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CommunicationAgentState } from '@mlswarm/contracts';
import { CharacterMotion, characterTiming, type CharacterClip } from './character-motion';
import './character-avatar.css';

const sheets = import.meta.glob<string>('./assets/characters/offbeat/sprites/*.webp', { eager: true, query: '?url', import: 'default' });
const listeners = new Set<() => void>();
let clock = 0, frameRequest = 0, lastPublish = 0;
const tick = (time: number) => {
  if (time - lastPublish >= 80) { clock = time; lastPublish = time; listeners.forEach(listener => listener()); }
  if (listeners.size) frameRequest = requestAnimationFrame(tick);
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) frameRequest = requestAnimationFrame(tick);
  return () => { listeners.delete(listener); if (!listeners.size) cancelAnimationFrame(frameRequest); };
};
const inactive = () => () => {};
const now = () => typeof performance === 'undefined' ? 0 : performance.now();
export function CharacterAvatar({ character, src, state = 'idle', animationKey = character, onError }: { character: string; src: string; animationKey?: string; state?: CommunicationAgentState; onError?: () => void }) {
  const element = useRef<HTMLSpanElement>(null);
  const motion = useRef<CharacterMotion | null>(null);
  if (!motion.current) motion.current = new CharacterMotion(state, now(), characterTiming(animationKey));
  const [visible, setVisible] = useState(true), [reduced, setReduced] = useState(false);
  const [ready, setReady] = useState(''), [, redraw] = useState(0);
  const time = useSyncExternalStore(visible && !reduced ? subscribe : inactive, () => clock, () => 0);
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReduced(preference.matches);
    changed(); preference.addEventListener('change', changed);
    let intersects = true;
    const visibility = () => setVisible(intersects && !document.hidden);
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => { intersects = entries[0].isIntersecting; visibility(); });
    if (element.current) observer?.observe(element.current);
    document.addEventListener('visibilitychange', visibility); visibility();
    return () => { observer?.disconnect(); preference.removeEventListener('change', changed); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => { motion.current!.setState(state, now()); redraw(n => n + 1); }, [state]);
  useEffect(() => {
    const target = element.current;
    const sent = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      if (id) { motion.current!.message(id, now()); redraw(n => n + 1); }
    };
    target?.addEventListener('character-message', sent);
    return () => target?.removeEventListener('character-message', sent);
  }, []);
  const sampled = reduced ? { clip: state === 'needs_you' ? 'needs-you' : state === 'blocked' ? 'blocked' : 'neutral', frame: 11 } as { clip: CharacterClip; frame: number }
    : motion.current.sample(time || now());
  const sheet = sampled.clip === 'neutral' ? undefined : sheets[`./assets/characters/offbeat/sprites/${character}-${sampled.clip}.webp`];
  const showingAnimation = !!sheet && ready === sheet;
  return <span className="k42-character-avatar" ref={element} data-character-avatar="" data-character={character}
    data-motion={sampled.clip} data-frame={sampled.frame} aria-hidden="true">
    <span className="k42-character-stage">
    <img className="k42-character-neutral" src={src} alt="" decoding="async" onError={onError}
      style={{ visibility: showingAnimation ? 'hidden' : 'visible' }} />
    {sheet && <img key={sheet} className="k42-character-strip" src={sheet} alt="" decoding="async"
      onLoad={() => setReady(sheet)} onError={() => setReady('')}
      style={{ opacity: showingAnimation ? 1 : 0, transform: `translateX(-${sampled.frame / 12 * 100}%)` }} />}
    </span>
  </span>;
}
