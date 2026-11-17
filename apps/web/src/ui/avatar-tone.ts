// Pastel accent for initials avatars: one of five tones, stable per person (design 2026-10-16).
export const PASTEL_TONES = ['butter', 'sky', 'mint', 'blush', 'lilac'] as const;
export type PastelTone = typeof PASTEL_TONES[number];

/** FNV-1a over UTF-16 code units, so the same id always gets the same tone. */
export function stableHash(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) { hash ^= id.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}

/** People keep their existing warm initials colors. Agent family colors use ownerAppearance. */
export function personTone(id: string): 'blush' | 'butter' { return stableHash(id) % 2 ? 'butter' : 'blush'; }
