import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CommunicationAgentState } from '@mlswarm/contracts';
import { CharacterMotion, characterTiming, type CharacterClip } from './character-motion';
import { CharacterAmbient, ambientTiming, characterPointer, pupilOffset, rareEffectGate, subscribeCharacterPointer } from './character-ambient';
import rareGeometry from './assets/characters/offbeat/rare-geometry.json';
import { CharacterPreview } from './character-preview';
import './character-avatar.css';

const sheets = import.meta.glob<string>('./assets/characters/offbeat/sprites/*.webp', { eager: true, query: '?url', import: 'default' });
const gazeImages = import.meta.glob<string>('./assets/characters/offbeat/gaze/*.png', { eager: true, query: '?url', import: 'default' });
const placement = rareGeometry as Record<string, { scale: number; x: number; y: number }>;
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
  const preview = useContext(CharacterPreview);
  const element = useRef<HTMLSpanElement>(null);
  const motion = useRef<CharacterMotion | null>(null);
  const ambient = useRef<CharacterAmbient | null>(null);
  if (!motion.current) motion.current = new CharacterMotion(state, now(), characterTiming(animationKey));
  if (!ambient.current) ambient.current = new CharacterAmbient(now(), ambientTiming(animationKey));
  const [visible, setVisible] = useState(true), [reduced, setReduced] = useState(false);
  const [ready, setReady] = useState(''), [, redraw] = useState(0);
  const [rareReady, setRareReady] = useState(''), [gazeReady, setGazeReady] = useState(''), [fine, setFine] = useState(false);
  const rareSheet = sheets[`./assets/characters/offbeat/sprites/${character}-rare.webp`];
  const gaze = ['base', 'pupil-0', 'pupil-1'].map(part => gazeImages[`./assets/characters/offbeat/gaze/${character}-${part}.png`]);
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
  useEffect(() => {
    const preference = matchMedia('(hover: hover) and (pointer: fine)');
    const changed = () => setFine(preference.matches);
    changed(); preference.addEventListener('change', changed);
    return () => preference.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setGazeReady('');
    if (gaze.every(Boolean)) Promise.all(gaze.map(src => new Promise<void>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(); image.onerror = reject; image.src = src;
    }))).then(() => { if (!cancelled) setGazeReady(character); }, () => {});
    return () => { cancelled = true; };
  }, [character]);
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
  const pointer = useSyncExternalStore(fine && visible && !reduced ? subscribeCharacterPointer : inactive, characterPointer, () => null);
  const available = visible && !reduced && ['idle', 'waiting', 'working', 'completed'].includes(state)
    && ['blink', 'work-loop', 'neutral'].includes(sampled.clip);
  const scheduled = ambient.current.sample(time || now(), available && !preview, !!pointer && gazeReady === character,
    () => !!rareSheet && rareReady === rareSheet && rareEffectGate.claim(time || now()), sampled.frame === 0);
  const decoration: ReturnType<CharacterAmbient['sample']> = preview === 'gaze' && visible && !reduced && pointer && gazeReady === character
    ? { kind: 'gaze', amount: 1 } : scheduled;
  const rare = decoration.kind === 'rare' && rareReady === rareSheet;
  const looking = decoration.kind === 'gaze' && gazeReady === character && !!pointer;
  const box = looking ? element.current?.getBoundingClientRect() : undefined;
  const offset = looking && box ? pupilOffset(pointer!.x - box.left - box.width / 2, pointer!.y - box.top - box.height / 2, decoration.amount!) : { x: 0, y: 0 };
  const sheet = sampled.clip === 'neutral' ? undefined : sheets[`./assets/characters/offbeat/sprites/${character}-${sampled.clip}.webp`];
  const showingAnimation = !!sheet && ready === sheet && !looking && !rare;
  return <span className="k42-character-avatar" ref={element} data-character-avatar="" data-character={character}
    data-motion={rare ? 'rare' : looking ? 'gaze' : sampled.clip} data-frame={rare ? decoration.frame : sampled.frame} aria-hidden="true">
    <span className="k42-character-stage">
    <img className="k42-character-neutral" src={src} alt="" decoding="async" onError={onError}
      style={{ visibility: showingAnimation || looking ? 'hidden' : 'visible', opacity: rare ? 1 - decoration.opacity! : 1 }} />
    {sheet && <img key={sheet} className="k42-character-strip" src={sheet} alt="" decoding="async"
      onLoad={() => setReady(sheet)} onError={() => setReady('')}
      style={{ opacity: showingAnimation ? 1 : 0, transform: `translateX(-${sampled.frame / 12 * 100}%)` }} />}
    {looking && <span className="k42-character-gaze" style={{maskImage:`url("${src}")`,maskSize:'100% 100%',maskRepeat:'no-repeat'}}>
      <img src={gaze[0]} alt="" />
      {gaze.slice(1).map((src, index) => <img key={index} src={src} alt=""
        style={{ transform: `translate(${offset.x / 192 * 100}%, ${offset.y / 192 * 100}%)` }} />)}
    </span>}
    {rareSheet && <span className="k42-character-rare" style={{ opacity: rare ? decoration.opacity : 0,
      transform: `translate(${placement[character]?.x ?? 0}%, ${placement[character]?.y ?? 0}%) scale(${placement[character]?.scale ?? 1})` }}>
      <img className="k42-character-strip" src={rareSheet} alt="" decoding="async"
        onLoad={() => setRareReady(rareSheet)} onError={() => setRareReady('')}
        style={{ transform: `translateX(-${(rare ? decoration.frame! : 0) / 12 * 100}%)` }} />
    </span>}
    </span>
  </span>;
}
