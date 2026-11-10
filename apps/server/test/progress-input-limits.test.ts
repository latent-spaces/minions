import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PROGRESS_LIMITS } from '@mlswarm/contracts';
import { PUBLISH_PROGRESS_INPUT } from '../src/projects/progress.js';

const valid = { clientRequestId: 'update-1', body: 'Shipped.', links: [],
  screenshot: { uploadId: 'a'.repeat(64), alt: 'A card', representation: 'concept_image' } };

describe('project update input limits', () => {
  it('names the character limit when alt text is too long', () => {
    const result = PUBLISH_PROGRESS_INPUT.safeParse({ ...valid, screenshot: { ...valid.screenshot, alt: '😀'.repeat(PROGRESS_LIMITS.alt + 1) } });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]).toMatchObject({ path: ['screenshot', 'alt'], message: `Use at most ${PROGRESS_LIMITS.alt} Unicode characters.` });
  });
  it('counts characters, not UTF-16 units, at the limit', () => {
    expect(PUBLISH_PROGRESS_INPUT.safeParse({ ...valid, screenshot: { ...valid.screenshot, alt: '😀'.repeat(PROGRESS_LIMITS.alt) } }).success).toBe(true);
  });
  it('advertises the limits in the tool schema agents read', () => {
    const schema = JSON.stringify(z.toJSONSchema(PUBLISH_PROGRESS_INPUT, { unrepresentable: 'any' }));
    expect(schema).toContain(`At most ${PROGRESS_LIMITS.alt} Unicode characters.`);
    expect(schema).toContain(`At most ${PROGRESS_LIMITS.body} Unicode characters.`);
  });
});
