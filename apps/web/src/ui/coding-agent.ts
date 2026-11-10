/** Tool identity comes from execution metadata, never from a model name. */
export function codingAgent(provider: string | null | undefined) {
  if (provider === 'claude') return { id: 'claude', name: 'Claude Code' } as const;
  if (provider === 'codex') return { id: 'codex', name: 'Codex' } as const;
  return null;
}
