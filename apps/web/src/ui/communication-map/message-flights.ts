import type { Traffic } from './layout';
const DURATION = 1400;
export type MessageFlight = { from: string; to: string; phase: number };

/** A flight belongs to an actual message, never a repeating connection animation. */
export class MessageFlights {
  private mode: boolean | null = null;
  private floor = 0;
  private lastAt = 0;
  private seen = new Map<string, number>();
  private flights: { from: string; to: string; start: number }[] = [];
  private starts: { from: string; id: string }[] = [];
  takeStarts() { const starts = this.starts; this.starts = []; return starts; }

  sample(rows: Traffic[], at: number, clock: number, replay: boolean, running: boolean): MessageFlight[] {
    this.starts = [];
    // Server refreshes can correct the extrapolated live clock backwards. Only
    // a replay seek starts a new traversal; live message IDs must survive polls.
    const reset = this.mode === null || this.mode !== replay || replay && (at < this.lastAt || !running && at !== this.lastAt);
    if (reset) {
      this.mode = replay; this.floor = at; this.seen.clear(); this.flights = [];
    }
    this.lastAt = at;
    // The first live snapshot is history, not a new burst. Backwards seeks begin a new traversal.
    for (const [key, time] of this.seen) if (time < at - 300_000) this.seen.delete(key);
    for (const [index, message] of rows.entries()) {
      if (message.createdAt > at || message.createdAt < at - 300_000) continue;
      const key = message.id ?? JSON.stringify([message.agentId, message.to, message.createdAt, index]);
      if (this.seen.has(key)) continue;
      this.seen.set(key, message.createdAt);
      if (!running || (replay ? message.createdAt < this.floor : message.createdAt <= this.floor)) continue;
      if (message.audience === 'project' || message.to.some(to => to !== message.agentId)) this.starts.push({ from: message.agentId, id: key });
      if (message.audience !== 'direct') continue;
      for (const to of new Set(message.to)) if (to !== message.agentId) this.flights.push({ from: message.agentId, to, start: clock });
    }
    this.flights = this.flights.filter(flight => clock - flight.start < DURATION);
    return running ? this.flights.map(flight => ({ from: flight.from, to: flight.to, phase: Math.max(0, (clock - flight.start) / DURATION) })) : [];
  }
}
