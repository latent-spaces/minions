import { PERSONA_OPTIONS, type PersonaChoice } from '@mlswarm/contracts';
import { characterGeometry } from './character-set';
import geometry from './assets/characters/offbeat/geometry.json';
const sprites = import.meta.glob<string>('./assets/characters/offbeat/hats/*.png', { eager: true, query: '?url', import: 'default' });
const personaHats = { build: 'construction', review: 'detective', updates: 'conductor', moderator: 'police', custom: 'beret' };
/** A separate decorative sprite; switching persona never regenerates or rescales the face. */
export function agentHat(persona: PersonaChoice | null | undefined, character: string) {
  if (!persona || persona === 'default' || !Object.hasOwn(personaHats, persona)) return null;
  const head = characterGeometry(character), id = personaHats[persona as keyof typeof personaHats];
  const hat = geometry.hats.find(item => item.id === id)!;
  const width = head.hatWidth * hat.widthRatio, height = width * hat.height / hat.width;
  return { label: PERSONA_OPTIONS.find(option => option.id === persona)?.label ?? 'Custom',
    src: sprites[`./assets/characters/offbeat/hats/${id}.png`], width: width / 192,
    left: (head.anchor[0] - width * hat.attachment[0]) / 192,
    top: (head.anchor[1] - height * hat.attachment[1]) / 192, behind: head.hatBehind };
}
