import type { PublicProfilePhoto } from './profile-photos.js';
// Deliberately published contributions, independent of messaging and execution.
type ProgressProfileRef = { id: string; name: string | null; photo?: PublicProfilePhoto | null };
type ProgressAgentRef = { id: string; name: string };
type ProgressLink = { url: string; label: string; purpose: 'evidence' | 'result'; availability: 'unknown' };
export type ScreenshotInput = { uploadId: string; alt: string; caption?: string; representation: 'output_screenshot' | 'concept_image' };
export type ProgressScreenshot = {
  id: string; contentPath: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  byteSize: number; width: number; height: number; alt: string; caption: string | null;
  representation: ScreenshotInput['representation']; provenance: 'author_upload';
};
export type PublishedUpdate = {
  kind: 'authored_update'; id: string; projectId: string;
  author: { profile: ProgressProfileRef; agent: ProgressAgentRef | null };
  title: string | null; body: string; links: ProgressLink[]; screenshot: ProgressScreenshot | null; publishedAt: number;
};
export type ProgressSource = 'authored_updates' | 'result_history';
export type ProgressPage = {
  source: ProgressSource; audience: 'public' | 'member'; items: PublishedUpdate[];
  coverage: 'published_updates'; next: string | null; observedAt: number; bodyMaxLength: number;
};
export type PublishUpdateInput = {
  clientRequestId: string; title?: string; body: string;
  links: { url: string; label: string; purpose: ProgressLink['purpose'] }[]; screenshot: ScreenshotInput;
};
export type PublishUpdateReceipt = { update: PublishedUpdate; replayed: boolean };
export type ProgressUploadReceipt = { uploadId: string; mimeType: ProgressScreenshot['mimeType']; byteSize: number; width: number; height: number; replayed: boolean };
export const PROGRESS_LIMITS = {
  title: 120, briefBody: 300, body: 4000, links: 6, url: 2048, label: 120, requestId: 128,
  alt: 300, caption: 500, inputBytes: 24 * 1024, itemBytes: 32 * 1024,
  pageBytes: 48 * 1024, pageItems: 20, uploadBytes: 2 * 1024 * 1024,
  imageSide: 4096, imagePixels: 16_000_000, storedImageBytes: 2 * 1024 * 1024, displayImageSide: 2048,
} as const;

export type UpdateWritingStyle = 'brief' | 'detailed';
export type ProjectUpdateSettings = { writingStyle: UpdateWritingStyle; additionalInstructions: string; revision: number; updatedAt: number | null };
