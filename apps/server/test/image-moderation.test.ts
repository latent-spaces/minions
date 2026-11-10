import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Refusal } from '../src/errors.js';
import { assertImageAllowed, IMAGE_MODERATION_POLICY, imageModeration, moderatePublicImage, type ImageModerator } from '../src/projects/image-moderation.js';

const bytes = Buffer.from('synthetic normalized image bytes');
const annotation = () => ({ adult: 'VERY_UNLIKELY', violence: 'VERY_UNLIKELY', racy: 'VERY_UNLIKELY',
  medical: 'VERY_UNLIKELY', spoof: 'VERY_UNLIKELY' });
const response = (value = annotation()) => ({ responses: [{ safeSearchAnnotation: value }] });
// A synthetic moderator with the stored provider name; no real screening service is contacted.
const fake: ImageModerator = { provider: 'google_vision_safesearch', analyze: async () => response() };
beforeEach(() => { imageModeration.moderator = fake; });
afterEach(() => { vi.restoreAllMocks(); imageModeration.moderator = null; });

test('an allowed review records the exact checked pixels, policy and check time', async () => {
  const values = { adult: 'POSSIBLE', violence: 'POSSIBLE', racy: 'LIKELY', medical: 'VERY_LIKELY', spoof: 'VERY_LIKELY' };
  const analyze = vi.spyOn(fake, 'analyze').mockResolvedValue(response(values));
  const review = await moderatePublicImage(bytes, () => 1234);
  expect(analyze).toHaveBeenCalledExactlyOnceWith(bytes);
  expect(review).toEqual({ policy: IMAGE_MODERATION_POLICY, provider: 'google_vision_safesearch', checkedAt: 1234,
    imageSha256: createHash('sha256').update(bytes).digest('hex'), categories: values, decision: 'allowed' });
  expect(() => assertImageAllowed(review)).not.toThrow();
});

test.each([
  ['adult', 'LIKELY'], ['adult', 'VERY_LIKELY'],
  ['violence', 'LIKELY'], ['violence', 'VERY_LIKELY'], ['racy', 'VERY_LIKELY'],
])('%s at %s blocks publication', async (category, likelihood) => {
  vi.spyOn(fake, 'analyze').mockResolvedValue(response({ ...annotation(), [category]: likelihood }));
  const review = await moderatePublicImage(bytes, () => 1234);
  expect(review.decision).toBe('blocked');
  expect(() => assertImageAllowed(review)).toThrow(expect.objectContaining({ code: 'image_rejected' }));
});

test.each(['adult', 'violence', 'racy', 'medical', 'spoof'] as const)('missing or unknown %s never grants publication', async category => {
  const analyze = vi.spyOn(fake, 'analyze');
  const incomplete: Partial<ReturnType<typeof annotation>> = annotation();
  delete incomplete[category];
  for (const value of [incomplete, { ...annotation(), [category]: 'UNKNOWN' }, { ...annotation(), [category]: 'UNRECOGNIZED' }]) {
    analyze.mockResolvedValueOnce({ responses: [{ safeSearchAnnotation: value }] });
    await expect(moderatePublicImage(bytes, () => 1234)).rejects.toMatchObject({ code: 'moderation_unavailable', retryAfterSeconds: 30 });
  }
});

test.each([
  ['null response', null], ['missing responses', {}], ['empty responses', { responses: [] }],
  ['multiple responses', { responses: [response().responses[0], response().responses[0]] }],
  ['array-like responses', { responses: { 0: response().responses[0], length: 1 } }],
  ['provider error', { responses: [{ ...response().responses[0], error: { message: 'private provider detail' } }] }],
  ['missing annotation', { responses: [{}] }],
])('malformed provider envelope fails closed: %s', async (_label, value) => {
  vi.spyOn(fake, 'analyze').mockResolvedValue(value);
  await expect(moderatePublicImage(bytes, () => 1234)).rejects.toMatchObject({ code: 'moderation_unavailable', retryAfterSeconds: 30 });
});

test('provider failures become retryable refusals without exposing provider details', async () => {
  vi.spyOn(fake, 'analyze').mockRejectedValue(new Error('private provider detail'));
  const error = await moderatePublicImage(bytes, () => 1234).catch(error => error);
  expect(error).toBeInstanceOf(Refusal);
  expect(error).toMatchObject({ code: 'moderation_unavailable', retryAfterSeconds: 30 });
  expect(error.message).not.toContain('private provider detail');
});

test('without an installed moderator every public image is refused as unavailable', async () => {
  imageModeration.moderator = null;
  await expect(moderatePublicImage(bytes, () => 1234)).rejects.toMatchObject({ code: 'moderation_unavailable', retryAfterSeconds: 30 });
});
