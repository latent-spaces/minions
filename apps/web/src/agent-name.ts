// Suggestions are labels, never identity or credentials. Server IDs remain authoritative.
const qualities = ['white', 'shadow', 'silver', 'golden', 'quiet', 'swift', 'bright', 'misty', 'wild', 'amber', 'gentle', 'brave', 'moon', 'sun', 'snow', 'river', 'forest', 'storm', 'blue', 'red', 'copper', 'dawn', 'dusk', 'star'];
const creatures = ['fox', 'wolf', 'owl', 'otter', 'lynx', 'raven', 'falcon', 'bear', 'deer', 'hare', 'panda', 'tiger', 'lion', 'badger', 'heron', 'robin', 'wren', 'dolphin', 'whale', 'moth', 'wind', 'willow', 'cedar', 'brook'];

export function userPrefix(name?: string | null): string {
  // Use a public name, never an email address. The complete suggestion is editable.
  const first = (name ?? '').trim().split(/\s+/)[0].split('@')[0];
  return first.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/g, '') || 'explorer';
}

export function suggestAgentName(prefix: string, occupied: readonly string[] = []): string {
  const used = new Set(occupied);
  const count = qualities.length * creatures.length;
  const entropy = crypto.getRandomValues(new Uint32Array(1))[0];
  const start = entropy % count;
  for (let offset = 0; offset < count; offset++) {
    const index = (start + offset) % count;
    const candidate = `${userPrefix(prefix)}-${qualities[Math.floor(index / creatures.length)]}-${creatures[index % creatures.length]}`;
    if (!used.has(candidate)) return candidate;
  }
  // Human-readable fallback when every pair is taken; no opaque hexadecimal suffix.
  const base = `${userPrefix(prefix)}-white-fox`;
  let number = 2;
  while (used.has(`${base}-${number}`)) number++;
  return `${base}-${number}`;
}
