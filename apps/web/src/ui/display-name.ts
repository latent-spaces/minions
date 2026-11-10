/** A display name fit to greet someone with: trimmed, non-empty and not an email. */
export function usableName(name: string | null | undefined): string | null {
  const value = name?.trim();
  return value && !value.includes('@') ? value : null;
}
