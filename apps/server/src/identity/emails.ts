/** Sign-in emails as invitations match them: trimmed, lowercase, without duplicates, in the given order, at most 30. */
export function normalizeEmails(emails: readonly string[]): string[] {
  return [...new Set(emails.map(email => email.trim().toLowerCase()).filter(email => email.length > 0 && email.length <= 254))].slice(0, 30);
}
