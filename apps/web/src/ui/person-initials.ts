/** Up to two initials from a display name: the first character of each of the first two words. */
export function personInitials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => [...word][0]).join('').toUpperCase();
}
