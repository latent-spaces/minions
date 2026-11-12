import { stableHash } from './avatar-tone.js';
import type { CommunicationAgentState } from '@mlswarm/contracts';

export type CharacterClip = 'neutral' | 'blink' | 'work-enter' | 'work-loop' | 'stop' | 'needs-you' | 'blocked' | 'message';
export const CHARACTER_FRAME_MS = 160, CHARACTER_FRAME_COUNT = 12;
const duration = CHARACTER_FRAME_MS * CHARACTER_FRAME_COUNT;
export function characterTiming(id: string) {
  const hash = stableHash(`character-motion:${id}`);
  const interval = Math.round((12_000 + hash % 8_001) / .75);
  return { interval, offset: (hash >>> 8) % interval, rate: .85 + (hash >>> 16) % 31 / 100 };
}
const quiet = (state: CommunicationAgentState) => ['offline', 'revoked', 'unknown'].includes(state);

/** Presentation only: state comes from the existing freshness-aware observation. */
export class CharacterMotion {
  private state: CommunicationAgentState;
  private clip: CharacterClip = 'neutral';
  private began: number;
  private next: CharacterClip[] = [];
  private lastMessage: string | null = null;
  constructor(state: CommunicationAgentState, now: number, private timing = { interval: 21_333, offset: 0, rate: 1 }) {
    this.state = state; this.began = now; this.next = this.destination(state);
  }
  private destination(state: CommunicationAgentState): CharacterClip[] {
    if (quiet(state)) return [];
    return [state === 'working' ? 'work-enter' : state === 'needs_you' ? 'needs-you' : state === 'blocked' ? 'blocked' : 'blink'];
  }
  setState(state: CommunicationAgentState, now: number) {
    if (this.state === state) return;
    this.state = state;
    if (quiet(state)) { this.clip = 'neutral'; this.next = []; this.began = now; return; }
    if (this.clip === 'stop' && ['pausing', 'paused', 'stopped', 'completed', 'idle', 'waiting', 'pause_unconfirmed'].includes(state)) return;
    const working = this.clip === 'work-enter' || this.clip === 'work-loop';
    if (working && !['working', 'needs_you', 'blocked'].includes(state)) {
      this.clip = 'stop'; this.next = this.destination(state); this.began = now; return;
    }
    this.clip = 'neutral'; this.next = this.destination(state); this.began = now;
  }
  message(id: string, now: number) {
    if (id === this.lastMessage) return;
    this.lastMessage = id;
    if (!['working', 'idle', 'waiting', 'completed'].includes(this.state)) return;
    this.clip = 'neutral'; this.next = ['message']; this.began = now;
  }
  sample(now: number): { clip: CharacterClip; frame: number } {
    for (let guard = 0; guard < 8; guard++) {
      const elapsed = Math.max(0, now - this.began);
      if (this.clip === 'neutral') {
        if (!this.next.length || elapsed < CHARACTER_FRAME_MS) return { clip: 'neutral', frame: 0 };
        this.clip = this.next.shift()!; this.began += CHARACTER_FRAME_MS; continue;
      }
      if (this.clip === 'blink' || this.clip === 'work-loop') {
        // Play a normal-speed facial gesture once, then hold canonical eyes open.
        // Slowing the strip itself would leave eyes half closed for seconds.
        const phase = (elapsed + this.timing.offset) % this.timing.interval;
        return { clip: this.clip, frame: phase < duration
          ? Math.min(CHARACTER_FRAME_COUNT - 1, Math.floor(phase * this.timing.rate / CHARACTER_FRAME_MS)) : 0 };
      }
      if (elapsed < duration) return { clip: this.clip, frame: Math.floor(elapsed / CHARACTER_FRAME_MS) };
      if (this.clip === 'needs-you' || this.clip === 'blocked') return { clip: this.clip, frame: 11 };
      const finished = this.clip;
      this.clip = finished === 'work-enter' ? 'work-loop'
        : finished === 'message' && this.state === 'working' ? 'work-loop'
        : this.next.shift() ?? 'blink';
      this.began += duration;
    }
    return { clip: 'neutral', frame: 0 };
  }
}
