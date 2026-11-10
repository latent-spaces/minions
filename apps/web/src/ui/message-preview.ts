/** At most `max` characters, never splitting an emoji or other astral character into a lone surrogate. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const clipped = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

/** Authored summaries describe one message. Older/short messages use an honest excerpt. */
export function fullConversationTitle(body: string, summary?: string | null): string {
  return summary || body.split('\n').find(line => line.trim())?.trim() || body;
}

export function conversationTitle(body: string, summary?: string | null): string {
  const title = fullConversationTitle(body, summary);
  const characters = Array.from(title);
  if (characters.length <= 120) return title;
  const prefix = characters.slice(0, 119).join('');
  const boundary = prefix.search(/\s+\S*$/u);
  return (boundary >= 80 ? prefix.slice(0, boundary) : prefix).trimEnd() + '…';
}

export function messagePreview(body: string, summary?: string | null): string {
  if (summary) return summary;
  const first = fullConversationTitle(body);
  return first.length > 120 ? clipText(first, 119).trimEnd() + '…' : first;
}
