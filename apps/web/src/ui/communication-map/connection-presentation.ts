import { stableHash } from '../avatar-tone';
import { communicationWeights, type Link, type Traffic } from './layout';
import type { MessageFlight } from './message-flights';

export const CONNECTION_LIFETIME = 180_000;
/** Visual history lasts longer than the physical attraction used by the worker. */
export const connectionWeights = (rows: Traffic[], at: number) => communicationWeights(rows, at, 60_000, 300_000, CONNECTION_LIFETIME);

/** Replays recent traffic visually. Never delivers messages or emits avatar acknowledgments. */
export function repeatingConnectionFlights(links: Link[], clock: number): MessageFlight[] {
  return links.flatMap(link => {
    const phase = (clock + stableHash(JSON.stringify([link.from, link.to])) % 3600) % 3600;
    return phase < 1400 ? [{from:link.from,to:link.to,phase:phase/1400}] : [];
  });
}

export function connectionExcerpt(body: string, limit = 160) {
  const text = body.replace(/\s+/gu, ' ').trim(), characters = Array.from(text);
  return characters.length > limit ? characters.slice(0, limit).join('').trimEnd() + '…' : text;
}
