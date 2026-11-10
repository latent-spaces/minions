import { z } from 'zod';

const asset = z.string().regex(/^\/viewer\/project-concepts\/[a-z0-9-]+\.(?:jpg|png)$/);
const artwork = z.object({
  coverImage: asset,
  conceptImages: z.array(z.object({ src: asset, title: z.string().trim().min(1).max(120) })).max(2),
});
type ProjectArtwork = z.infer<typeof artwork>;

// Only curated same-origin image paths reach readers. Existing published catalog covers
// remain readable while their active local fixtures are migrated to approved-project artwork.
export function artworkOf(value: unknown, catalogCover?: unknown): Partial<ProjectArtwork> {
  const parsed = artwork.safeParse(value);
  if (parsed.success) return parsed.data;
  return typeof catalogCover === 'string' && /^\/viewer\/project-concepts\/[a-z-]+\.jpg$/.test(catalogCover)
    ? { coverImage: catalogCover } : {};
}
