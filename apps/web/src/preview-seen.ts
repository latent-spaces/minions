// The New dot beside Preview: the page changed since this person last opened Preview in this browser (owner, 15 November 2026).
export const previewSeenKey = (userId: string, projectId: string) => `mlswarm:preview-seen:v1:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`;
export function readPreviewSeen(key: string): number | null {
  try { const value = Number(localStorage.getItem(key)); return Number.isFinite(value) && value > 0 ? value : null; } catch { return null; }
}
export function writePreviewSeen(key: string, updatedAt: number) {
  try { localStorage.setItem(key, String(updatedAt)); } catch { /* No storage: the dot comes back on the next visit. */ }
}
export const previewIsNew = (updatedAt: number | null | undefined, seen: number | null) => typeof updatedAt === 'number' && (seen === null || updatedAt > seen);
