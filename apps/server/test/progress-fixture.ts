// Synthetic ready-upload metadata for tests of reminders/identity, not image transport.
// Real bytes, screening and retrieval are covered by project-update-images.test.tsx.
import { randomBytes } from 'node:crypto';
import { collection } from '../src/firestore.js';
import { IMAGE_MODERATION_POLICY } from '../src/projects/image-moderation.js';
import { TEST_PROJECT } from './helpers.js';
export async function seedProgressImage(publisherKey: string) {
  const uploadId = randomBytes(32).toString('hex'), digest = 'a'.repeat(64);
  await collection(`projects/${TEST_PROJECT}/progressUploads`).doc(uploadId).set({
    projectId: TEST_PROJECT, publisherKey, ready: true, attachedUpdateId: null,
    fingerprint: digest, createdAt: 1000, objectKey: 'synthetic-test-only', storedDigest: digest,
    media: { mimeType: 'image/webp', byteSize: 20, width: 8, height: 8 },
    moderation: { policy: IMAGE_MODERATION_POLICY, provider: 'google_vision_safesearch', decision: 'allowed',
      checkedAt: 1000, imageSha256: digest, categories: { adult: 'VERY_UNLIKELY', violence: 'VERY_UNLIKELY',
        racy: 'VERY_UNLIKELY', medical: 'VERY_UNLIKELY', spoof: 'VERY_UNLIKELY' } },
  });
  return { uploadId, alt: 'Synthetic test visual', representation: 'concept_image' as const };
}
