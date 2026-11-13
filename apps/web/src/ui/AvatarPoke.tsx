import { useEffect, useRef, useState, type ReactNode } from 'react';
import './avatar-poke.css';

/** Cosmetic, local-only feedback. The renderer accepts only decoded, interruptible poses. */
export function pokeCharacter(container: Element | null): boolean {
  const character = container?.matches('[data-character-avatar]') ? container : container?.querySelector('[data-character-avatar]');
  if (!character) return false;
  const event = new CustomEvent('character-poke', { cancelable: true });
  character.dispatchEvent(event);
  return event.defaultPrevented;
}

/** A sibling overlay keeps card/profile links separate and never nests a button in a link. */
export function AvatarPokeButton({ name, className = '' }: { name: string; className?: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const scope = button.current?.closest('[data-avatar-poke-scope]');
    if (!scope) return;
    const update = () => setAvailable(scope.querySelector('[data-character-avatar]')?.getAttribute('data-poke-available') === 'true');
    update();
    const observer = new MutationObserver(update);
    observer.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-poke-available'] });
    return () => observer.disconnect();
  }, []);
  return <button ref={button} type="button" className={`k42-avatar-poke ${className}`.trim()}
    disabled={!available} aria-label={`Poke ${name}'s character`} title={`Poke ${name}'s character`}
    onClick={event => { event.stopPropagation(); pokeCharacter(event.currentTarget.closest('[data-avatar-poke-scope]')); }} />;
}

/** Use only around standalone artwork, never inside an existing interactive element. */
export function PokeAvatar({ name, children }: { name: string; children: ReactNode }) {
  return <span className="k42-avatar-poke-surface" data-avatar-poke-scope="">{children}<AvatarPokeButton name={name} /></span>;
}
