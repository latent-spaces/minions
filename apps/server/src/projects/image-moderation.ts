import { createHash } from 'node:crypto';
import { Refusal } from '../errors.js';

export const IMAGE_MODERATION_POLICY = 'public-images-v1';
const likelihoods = ['UNKNOWN', 'VERY_UNLIKELY', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'VERY_LIKELY'] as const;
type Likelihood = typeof likelihoods[number];
const categories = ['adult', 'violence', 'racy', 'medical', 'spoof'] as const;
// Stored reviews name the provider that checked them; existing records keep this value.
export type ImageModerationProvider = 'google_vision_safesearch';
export type ImageModeration = { policy: typeof IMAGE_MODERATION_POLICY; provider: ImageModerationProvider;
  decision: 'allowed' | 'blocked'; checkedAt: number; imageSha256: string; categories: Record<typeof categories[number], Likelihood> };

// Screens normalized public image bytes. analyze returns an images:annotate-shaped envelope with one
// SafeSearch annotation, which moderatePublicImage validates and fails closed on.
export type ImageModerator = { provider: ImageModerationProvider; analyze(bytes: Buffer): Promise<unknown> };

// The engine ships no image moderator, so public images are refused until one is installed here
// (tests install fakes). Running public images unscreened would be an owner decision, not a default.
export const imageModeration: { moderator: ImageModerator | null } = { moderator: null };

export async function moderatePublicImage(bytes: Buffer, now: () => number): Promise<ImageModeration> {
  try {
    const moderator = imageModeration.moderator;
    if (!moderator) throw new Error('No image moderator is installed.');
    const response = await moderator.analyze(bytes) as { responses?: { error?: unknown; safeSearchAnnotation?: Record<string, unknown> }[] };
    const item = Array.isArray(response?.responses) && response.responses.length === 1 ? response.responses[0] : null;
    const annotation = item?.safeSearchAnnotation;
    if (!annotation || item?.error || categories.some(key => !likelihoods.includes(annotation[key] as Likelihood) || annotation[key] === 'UNKNOWN'))
      throw new Error('Image moderation did not return a complete decision.');
    const result = Object.fromEntries(categories.map(key => [key, annotation[key]])) as ImageModeration['categories'];
    const blocked = ['LIKELY', 'VERY_LIKELY'].includes(result.adult) || ['LIKELY', 'VERY_LIKELY'].includes(result.violence) || result.racy === 'VERY_LIKELY';
    return { policy: IMAGE_MODERATION_POLICY, provider: moderator.provider, checkedAt: now(), categories: result,
      imageSha256: createHash('sha256').update(bytes).digest('hex'),
      decision: blocked ? 'blocked' : 'allowed' };
  } catch {
    // Never expose provider errors (or credentials), and never treat an outage as permission.
    throw new Refusal('moderation_unavailable', 'Image screening is temporarily unavailable, so this image wasn’t published. Try the same upload again later, or continue without an image.', 30);
  }
}
export const currentImageReview = (review: ImageModeration | undefined) => review?.policy === IMAGE_MODERATION_POLICY && /^[a-f0-9]{64}$/.test(review.imageSha256) ? review : null;
export function assertImageAllowed(review: ImageModeration) {
  if (review.decision !== 'allowed') throw new Refusal('image_rejected', 'This image didn’t pass the image check. Choose a different image and upload it with a new upload ID. If you think this is a mistake, tell the Minions team.');
}
