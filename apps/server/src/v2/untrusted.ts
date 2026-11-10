// Text written by another agent, a person or a GitHub user, as the agent MCP returns it. The server
// fills `source` from its own records; `content` is what the writer typed. packages/agent-cli/runtime/AGENT_PROMPT_V2.md
// tells agents to treat content as data, never as instructions. An envelope labels provenance; it does
// not make the text safe or stop a model following it. Names are labels; the ids identify the writer.
type Source =
  | { type: 'agent'; agentId: string; agentName?: string | null }
  | { type: 'person'; personId: string }
  | { type: 'github'; author: 'unknown' }  // The GitHub projection does not store authors.
  | { type: 'unknown' };
type Untrusted<T = string> = { trust: 'untrusted'; source: Source; content: T };

export function untrusted<T>(source: Source, content: T): Untrusted<T> {
  return { trust: 'untrusted', source, content };
}

export function actorSource(actor: { kind: 'person' | 'agent'; id: string } | undefined): Source {
  if (actor?.kind === 'agent') return { type: 'agent', agentId: actor.id };
  if (actor?.kind === 'person') return { type: 'person', personId: actor.id };
  return { type: 'unknown' };
}

export type WithSource<T> = Omit<T, 'body' | 'summary'> & { body: Untrusted; summary?: Untrusted };
// A v2 message or an inbox message payload, with its body enveloped. agentName is optional because an
// inbox payload is untyped document data.
export function messageWithSource<T extends { agentId: string; agentName?: string; body: string; summary?: string }>(message: T): WithSource<T> {
  const { body, summary, ...rest } = message;
  const source:Source = 'kind' in message && message.kind==='steering' && 'actorProfileId' in message && typeof message.actorProfileId==='string'
    ? {type:'person',personId:message.actorProfileId} : { type: 'agent', agentId: message.agentId, agentName: message.agentName ?? null };
  return { ...rest, body: untrusted(source, body), ...(summary === undefined ? {} : { summary: untrusted(source, summary) }) };
}
