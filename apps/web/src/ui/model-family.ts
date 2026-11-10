// Runner/provider identity can differ from a reported model after routing. A
// decorative family mark follows a recognized model ID; unknown IDs stay neutral.
export function modelFamily(model: string | null | undefined, _provider?: string | null) {
  if (!model) return null;
  const id = model.trim();
  if (/^(?:anthropic\/)?claude(?:-|$)/i.test(id)) return { label: 'Claude', tone: 'claude' };
  if (/^(?:openai\/)?(?:gpt(?:-|$)|codex(?:-|$)|o[1-9]\d*(?:-|$))/i.test(id)) return { label: 'OpenAI', tone: 'openai' };
  if (/^(?:google\/)?gemini(?:-|$)/i.test(id)) return { label: 'Gemini', tone: 'gemini' };
  return null;
}
