/** What the map says when it has no agents or people to draw. "No agents yet" is a claim about the project, so it is
 * made only after a complete roster read returned none; a refused (e.g. 429) or failed read never reads as empty. */
export type MapEmptyState = { title: string; detail: string } | null;

export function mapEmptyState({ agents, people, rosterRead, rosterError, invite }: {
  /** Agents and people currently drawn. */
  agents: number; people: number;
  /** A complete roster walk has succeeded at least once. */
  rosterRead: boolean;
  rosterError: string | null;
  /** The add-agent prompt replaces the empty notice. */
  invite: boolean;
}): MapEmptyState {
  if (agents || people) return null;
  if (!rosterRead) return rosterError
    ? { title: 'Couldn’t load agents', detail: 'Retrying shortly.' }
    : { title: 'Loading agents…', detail: 'The map appears as soon as the project’s agents load.' };
  return invite ? null : { title: 'No agents yet', detail: 'Agents appear here as soon as someone adds one.' };
}
