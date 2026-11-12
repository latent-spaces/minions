import { stableHash } from './avatar-tone.js';

export const RARE_DURATION = 1920;
export function ambientTiming(id: string) {
  const hash = stableHash(`character-ambient:${id}`);
  return { rareInterval: (180_000 + hash % 240_001) / 2, rareDelay: (60_000 + (hash >>> 2) % 180_001) / 2,
    gazeInterval: (28_000 + (hash >>> 3) % 20_001) / 2, gazeDelay: (5_000 + (hash >>> 5) % 28_001) / 2,
    gazeDuration: 10_000 + (hash >>> 8) % 5001 };
}

/** One rare flourish on screen at a time, at least thirty seconds between starts. */
export class RareEffectGate {
  private next = 0;
  claim(now: number) { if (now < this.next) return false; this.next = now + 30_000; return true; }
}
export const rareEffectGate = new RareEffectGate();

/** Decorative behavior never changes an agent's actual work/connection state. */
export class CharacterAmbient {
  private nextRare: number;
  private nextGaze: number;
  private rareBegan = -Infinity;
  private gazeBegan = -Infinity;
  private hadPointer = false;
  constructor(now: number, private timing = ambientTiming('default')) {
    this.nextRare = now + timing.rareDelay; this.nextGaze = now + timing.gazeDelay;
  }
  sample(now: number, available: boolean, pointer: boolean, claimRare: () => boolean, canStart = true) {
    if (!available) {
      this.rareBegan = this.gazeBegan = -Infinity;
      this.hadPointer = false;
      // A hidden or interrupted instance does not immediately replay on return.
      this.nextRare = Math.max(this.nextRare, now + this.timing.rareDelay);
      this.nextGaze = Math.max(this.nextGaze, now + this.timing.gazeDelay);
      return { kind: 'none' as const };
    }
    if (canStart && now >= this.nextRare && now - this.rareBegan >= RARE_DURATION) {
      const granted = claimRare();
      this.nextRare = now + (granted ? this.timing.rareInterval : 7000);
      if (granted) {
        this.rareBegan = now; this.gazeBegan = -Infinity;
      }
    }
    const rareElapsed = now - this.rareBegan;
    if (rareElapsed < RARE_DURATION) return { kind: 'rare' as const,
      frame: Math.min(11, Math.floor(rareElapsed / 160)),
      opacity: Math.max(0, Math.min(1, rareElapsed / 160, (RARE_DURATION - rareElapsed) / 160)) };
    if (!pointer) { this.hadPointer = false; this.gazeBegan = -Infinity; return { kind: 'none' as const }; }
    if (!this.hadPointer) {
      this.hadPointer = true;
      // First cursor activity must not make every overdue avatar glance at once.
      this.nextGaze = Math.max(this.nextGaze, now + this.timing.gazeDelay);
    }
    if (canStart && now >= this.nextGaze) {
      this.gazeBegan = now;
      this.nextGaze = now + Math.max(this.timing.gazeInterval, this.timing.gazeDuration + 2000);
    }
    const elapsed = now - this.gazeBegan;
    if (elapsed < this.timing.gazeDuration) return { kind: 'gaze' as const,
      amount: Math.max(0, Math.min(1, elapsed / 240, (this.timing.gazeDuration - elapsed) / 400)) };
    return { kind: 'none' as const };
  }
}

export function pupilOffset(dx: number, dy: number, amount: number) {
  const distance = Math.hypot(dx, dy);
  // A dead zone settles the gaze near the avatar; smooth saturation avoids jitter.
  const travel = Math.min(8, Math.max(0, distance - 18) / 28) * amount;
  return distance ? { x: dx / distance * travel, y: dy / distance * travel } : { x: 0, y: 0 };
}

let pointer: { x: number; y: number } | null = null;
const pointerListeners = new Set<() => void>();
let pointerFrame = 0;
const publishPointer = () => {
  if (!pointerFrame) pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0; pointerListeners.forEach(listener => listener());
  });
};
const move = (event: MouseEvent) => {
  if ('pointerType' in event && event.pointerType === 'touch') return;
  pointer = { x: event.clientX, y: event.clientY }; publishPointer();
};
const leave = () => { pointer = null; publishPointer(); };
export function subscribeCharacterPointer(listener: () => void) {
  pointerListeners.add(listener);
  if (pointerListeners.size === 1) {
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('mousemove', move, { passive: true });
    window.addEventListener('pointerdown', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    window.addEventListener('blur', leave);
  }
  return () => {
    pointerListeners.delete(listener);
    if (!pointerListeners.size) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('pointerdown', move);
      document.documentElement.removeEventListener('pointerleave', leave);
      window.removeEventListener('blur', leave); pointer = null;
      cancelAnimationFrame(pointerFrame); pointerFrame = 0;
    }
  };
}
export const characterPointer = () => pointer;
