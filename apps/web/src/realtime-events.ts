export type RealtimeTopic = 'conversations' | 'agents' | 'needs-you' | 'teams';
const allowed = new Set(['conversations', 'agents', 'needs-you', 'teams']);

// Streaming fetch can split UTF-8 and event delimiters at any byte. TextDecoder
// handles the former; this bounded parser handles the latter and ignores heartbeats.
export function realtimeParser(receive: (topics: RealtimeTopic[]) => void) {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 16384) throw Error('Invalid update stream.');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = event.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
      if (!data) continue;
      const value: unknown = JSON.parse(data);
      if (!value || typeof value !== 'object' || !('topics' in value) || !Array.isArray(value.topics) || !value.topics.length || value.topics.some(topic => !allowed.has(topic))) throw Error('Invalid update event.');
      receive([...new Set(value.topics)]);
    }
  };
}
