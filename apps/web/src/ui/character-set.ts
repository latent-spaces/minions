import { PERSON_CHARACTERS, type PersonCharacter } from '@mlswarm/contracts';
import { stableHash, PASTEL_TONES } from './avatar-tone';
import geometry from './assets/characters/offbeat/geometry.json';

const portraits = import.meta.glob<string>('./assets/characters/offbeat/*.png', { eager: true, query: '?url', import: 'default' });
export const ANIMAL_CHARACTERS = ['cat', 'dog', 'fox', 'raccoon', 'bear', 'panda', 'rabbit', 'owl', 'koala', 'frog', 'red-panda', 'tiger'] as const;
export type AnimalCharacter = typeof ANIMAL_CHARACTERS[number];
export const characterSource = (id: string) => portraits[`./assets/characters/offbeat/${id}.png`];
export const PERSON_PORTRAITS = Object.fromEntries(PERSON_CHARACTERS.map(id => [id, characterSource(id)])) as Record<PersonCharacter, string>;
/** Decorative identity is independent of coding tool, model, name and roster order. */
export function agentCharacter(id: string) {
  const character = ANIMAL_CHARACTERS[stableHash(`offbeat-agent-v1:${id}`) % ANIMAL_CHARACTERS.length];
  return { id: character, src: characterSource(character) };
}
export function personCharacter(id: string, character?: PersonCharacter | null) {
  return character ?? PERSON_CHARACTERS[stableHash(`offbeat-person-v1:${id}`) % PERSON_CHARACTERS.length];
}
export function personPortrait(id: string, character?: PersonCharacter | null) {
  return PERSON_PORTRAITS[personCharacter(id, character)];
}
export const characterGeometry = (id: string) => geometry.heads.find(head => head.id === id)!;
export const ownerTone = (ownerId?: string | null) => ownerId ? PASTEL_TONES[stableHash(`tone-v1:${ownerId}`) % PASTEL_TONES.length] : null;
