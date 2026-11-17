import type { PublicProfilePhoto } from './profile-photos.js';
// Deliberately published contributions, independent of messaging and execution.
type ProgressProfileRef = { id: string; name: string | null; photo?: PublicProfilePhoto | null; character?: import('./profile-photos.js').PersonCharacter | null };
type ProgressAgentRef = { id: string; name: string; provider?: string };
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
  title: string | null; body: string; links: ProgressLink[];
  /** The first image; also the project's cover. */
  screenshot: ProgressScreenshot | null;
  /** Every image in order, the first included: one to five slides (owner, 12 November 2026). */
  slides: ProgressScreenshot[]; publishedAt: number;
};
export type ProgressSource = 'authored_updates' | 'result_history';
export type ProgressPage = {
  source: ProgressSource; audience: 'public' | 'member'; items: PublishedUpdate[];
  coverage: 'published_updates'; next: string | null; observedAt: number;
};
export type PublishUpdateInput = {
  clientRequestId: string; title: string; body: string;
  links: { url: string; label: string; purpose: ProgressLink['purpose'] }[]; screenshot: ScreenshotInput;
  /** Up to four more images after screenshot, when the project allows slides. */
  moreSlides?: ScreenshotInput[];
};
export type PublishUpdateReceipt = { update: PublishedUpdate; replayed: boolean };
export type ProgressUploadReceipt = { uploadId: string; mimeType: ProgressScreenshot['mimeType']; byteSize: number; width: number; height: number; replayed: boolean };
export const PROGRESS_LIMITS = {
  title: 60, body: 140, slides: 5, instructions: 1000, links: 6, url: 2048, label: 120, requestId: 128,
  alt: 300, caption: 500, inputBytes: 24 * 1024, itemBytes: 32 * 1024,
  pageBytes: 48 * 1024, pageItems: 20, uploadBytes: 2 * 1024 * 1024,
  imageSide: 4096, imagePixels: 16_000_000, storedImageBytes: 2 * 1024 * 1024, displayImageSide: 2048,
} as const;

// What the owner chooses for a project's updates (owner, 12 November 2026): how often the team posts,
// what is worth a post, whether a post may carry several slides, and a short note of their own.
export const UPDATE_EVERY_MINUTES = [5, 15, 30] as const;
export type UpdateEveryMinutes = typeof UPDATE_EVERY_MINUTES[number];
export const UPDATE_TOPICS = ['results', 'blockers', 'decisions', 'summaries'] as const;
export type UpdateTopic = typeof UPDATE_TOPICS[number];
export type ProjectUpdateSettings = { everyMinutes: UpdateEveryMinutes; topics: UpdateTopic[]; slides: boolean; additionalInstructions: string; revision: number; updatedAt: number | null };
