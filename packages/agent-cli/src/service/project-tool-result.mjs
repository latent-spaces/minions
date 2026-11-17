// Preserve protocol refusals at the tool facade without forwarding error.data or credentials.
export function projectToolResult(reply, secret) {
  if (reply?.error) {
    const raw = reply.error;
    const redact = value => {
      let text = value;
      if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
      // Quoted diagnostic fragments are still text; never parse or forward their data.
      return text.replace(/(["'](?:authorization|access[_-]?token|refresh[_-]?token|token|api[_-]?key|client[_-]?secret|password)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"[redacted]"')
        .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
        .replace(/\b(authorization|access[_-]?token|refresh[_-]?token|token|api[_-]?key|client[_-]?secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        // Bound displayed characters (UTF-16 units), not encoded bytes.
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 256);
    };
    const code = Number.isSafeInteger(raw.code) ? raw.code
      : typeof raw.code === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(raw.code) && !raw.code.includes(secret || '\0') ? raw.code : 'project_refused';
    const message = typeof raw.message === 'string' ? redact(raw.message) : '';
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message: message || 'The project operation was refused. Read current project state before retrying.' } }) }] };
  }
  return reply?.result ?? { content: [{ type: 'text', text: 'Project operation was not confirmed.' }], isError: true };
}
