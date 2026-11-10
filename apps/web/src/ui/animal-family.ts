import fox1 from './assets/agents/families/fox-1.webp';
import fox2 from './assets/agents/families/fox-2.webp';
import fox3 from './assets/agents/families/fox-3.webp';
import fox4 from './assets/agents/families/fox-4.webp';
import cat1 from './assets/agents/families/cat-1.webp';
import cat2 from './assets/agents/families/cat-2.webp';
import cat3 from './assets/agents/families/cat-3.webp';
import cat4 from './assets/agents/families/cat-4.webp';
import bear1 from './assets/agents/families/bear-1.webp';
import bear2 from './assets/agents/families/bear-2.webp';
import bear3 from './assets/agents/families/bear-3.webp';
import bear4 from './assets/agents/families/bear-4.webp';
import rabbit1 from './assets/agents/families/rabbit-1.webp';
import rabbit2 from './assets/agents/families/rabbit-2.webp';
import rabbit3 from './assets/agents/families/rabbit-3.webp';
import rabbit4 from './assets/agents/families/rabbit-4.webp';
import owl1 from './assets/agents/families/owl-1.webp';
import owl2 from './assets/agents/families/owl-2.webp';
import owl3 from './assets/agents/families/owl-3.webp';
import owl4 from './assets/agents/families/owl-4.webp';
import parrot1 from './assets/agents/families/parrot-1.webp';
import parrot2 from './assets/agents/families/parrot-2.webp';
import parrot3 from './assets/agents/families/parrot-3.webp';
import parrot4 from './assets/agents/families/parrot-4.webp';
import turtle1 from './assets/agents/families/turtle-1.webp';
import turtle2 from './assets/agents/families/turtle-2.webp';
import turtle3 from './assets/agents/families/turtle-3.webp';
import turtle4 from './assets/agents/families/turtle-4.webp';
import frog1 from './assets/agents/families/frog-1.webp';
import frog2 from './assets/agents/families/frog-2.webp';
import frog3 from './assets/agents/families/frog-3.webp';
import frog4 from './assets/agents/families/frog-4.webp';
import penguin1 from './assets/agents/families/penguin-1.webp';
import penguin2 from './assets/agents/families/penguin-2.webp';
import penguin3 from './assets/agents/families/penguin-3.webp';
import penguin4 from './assets/agents/families/penguin-4.webp';
import seal1 from './assets/agents/families/seal-1.webp';
import seal2 from './assets/agents/families/seal-2.webp';
import seal3 from './assets/agents/families/seal-3.webp';
import seal4 from './assets/agents/families/seal-4.webp';
import elephant1 from './assets/agents/families/elephant-1.webp';
import elephant2 from './assets/agents/families/elephant-2.webp';
import elephant3 from './assets/agents/families/elephant-3.webp';
import elephant4 from './assets/agents/families/elephant-4.webp';
import hedgehog1 from './assets/agents/families/hedgehog-1.webp';
import hedgehog2 from './assets/agents/families/hedgehog-2.webp';
import hedgehog3 from './assets/agents/families/hedgehog-3.webp';
import hedgehog4 from './assets/agents/families/hedgehog-4.webp';
import { stableHash, PASTEL_TONES } from './avatar-tone';

// Version 1 identity palette: freeze order/cardinality to avoid reassigning existing
// people when adding artwork later. This is a visual cue, never proof of ownership.
export const ANIMAL_FAMILIES = ['fox', 'cat', 'bear', 'rabbit', 'owl', 'parrot', 'turtle', 'frog', 'penguin', 'seal', 'elephant', 'hedgehog'] as const;
export type AnimalFamily = typeof ANIMAL_FAMILIES[number];
const portraits = {
  fox: [fox1, fox2, fox3, fox4],
  cat: [cat1, cat2, cat3, cat4],
  bear: [bear1, bear2, bear3, bear4],
  rabbit: [rabbit1, rabbit2, rabbit3, rabbit4],
  owl: [owl1, owl2, owl3, owl4],
  parrot: [parrot1, parrot2, parrot3, parrot4],
  turtle: [turtle1, turtle2, turtle3, turtle4],
  frog: [frog1, frog2, frog3, frog4],
  penguin: [penguin1, penguin2, penguin3, penguin4],
  seal: [seal1, seal2, seal3, seal4],
  elephant: [elephant1, elephant2, elephant3, elephant4],
  hedgehog: [hedgehog1, hedgehog2, hedgehog3, hedgehog4],
};

/** Owner id is the only grouping key: names, roster order and project do not affect it. */
export function ownerAppearance(ownerId: string) {
  const family = ANIMAL_FAMILIES[stableHash(`family-v1:${ownerId}`) % 12];
  const tone = PASTEL_TONES[stableHash(`tone-v1:${ownerId}`) % 5];
  return { family, tone };
}

// Shared crop for HTML avatars and SVG map portraits. Bias toward the face, not the chest.
export const ANIMAL_ZOOM = 1.25;
export const ANIMAL_FOCUS = .38;

export function agentPortrait(agentId: string, ownerId?: string | null) {
  const appearance = ownerId ? ownerAppearance(ownerId) : {
    family: ANIMAL_FAMILIES[stableHash(`unowned-v1:${agentId}`) % 12], tone: null,
  };
  const variant = stableHash(`portrait-v1:${agentId}`) % 4;
  return { ...appearance, variant, src: portraits[appearance.family][variant] };
}
