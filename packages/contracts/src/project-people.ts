/** A visible, signed-in web tab reports every 15 seconds; crashes expire without an offline write. */
export const WEB_PRESENCE_FRESH_MS = 45_000;
export type WebPresence = { online: boolean; freshUntil: number | null };
export type WebPresencePage = { generatedAt: number; people: Record<string, WebPresence> };
