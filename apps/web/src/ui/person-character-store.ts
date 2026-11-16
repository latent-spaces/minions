import { useEffect, useSyncExternalStore } from 'react';
import type { PersonCharacter } from '@minions/contracts';

const choices = new Map<string, PersonCharacter | null>();
const listeners = new Set<() => void>();
export function rememberPersonCharacter(id: string, character: PersonCharacter | null) {
  if (choices.has(id) && choices.get(id) === character) return;
  choices.set(id, character);
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Public display metadata shared across existing avatars, never an authority cache. */
export function usePersonCharacter(id: string | undefined, character: PersonCharacter | null | undefined) {
  const cached = useSyncExternalStore(subscribe, () => id ? choices.get(id) : undefined, () => undefined);
  useEffect(() => { if (id && character !== undefined) rememberPersonCharacter(id, character); }, [id, character]);
  return cached === undefined ? character : cached;
}
