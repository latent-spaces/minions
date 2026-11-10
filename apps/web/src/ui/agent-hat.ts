import { PERSONA_OPTIONS, type PersonaChoice } from '@mlswarm/contracts';
import type { AnimalFamily } from './animal-family';
import build from './assets/agents/hats/build.webp';
import review from './assets/agents/hats/review.webp';
import updates from './assets/agents/hats/updates.webp';
import moderator from './assets/agents/hats/moderator.webp';
import custom from './assets/agents/hats/custom.webp';

const hats = { build, review, updates, moderator, custom };
/** Decorative only: no new persona storage, execution role or permission. */
export function agentHat(persona: PersonaChoice | null | undefined, family: AnimalFamily) {
  if (!persona || persona === 'default' || !Object.hasOwn(hats, persona)) return null;
  const tallEars = ['fox', 'cat', 'rabbit', 'parrot'].includes(family);
  const fit = { width: family === 'rabbit' ? .58 : .66, top: tallEars ? -.10 : -.20 };
  const lift = persona === 'custom' || persona === 'review' ? .05 : 0;
  return { label: PERSONA_OPTIONS.find(option => option.id === persona)?.label ?? 'Custom', src: hats[persona as keyof typeof hats], width: fit.width, left: (1 - fit.width) / 2, top: fit.top - lift };
}
