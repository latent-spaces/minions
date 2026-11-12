export type CommunicationNode = { provider?: string | null; id: string; name: string | null };
export type CommunicationEdge = { from: string; to: string; count: number; latestAt: number };
export type PositionedAgent = CommunicationNode & { x: number; y: number };
export function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms/1000));
  const hours = Math.floor(seconds/3600), minutes = Math.floor(seconds%3600/60);
  return `${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
}
export function mergeEdges(first: CommunicationEdge[], next: CommunicationEdge[]) {
  const merged = new Map(first.map(e => [JSON.stringify([e.from,e.to]), {...e}]));
  for (const edge of next) {
    const key = JSON.stringify([edge.from,edge.to]), old = merged.get(key);
    merged.set(key, {...edge, count: edge.count+(old?.count??0), latestAt: Math.max(edge.latestAt, old?.latestAt??0)});
  }
  return [...merged.values()];
}
