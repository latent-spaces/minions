import type { PublicProfilePhoto } from './profile-photos.js';
// Public discovery DTOs deliberately exclude invitation/account metadata.
export type ProfileDirectorySummary = { id: string; name: string; bio: string; photo?: PublicProfilePhoto | null };
export type ProfileDirectoryPage = { profiles: ProfileDirectorySummary[]; next: string | null };

// Human-only private conversations; no agent execution effects.
export type MessageParticipant = { id: string; name: string; photo?: PublicProfilePhoto | null };
export type PrivateMessage = {
  id: string;
  sender: MessageParticipant;
  body: string;
  createdAt: number;
  /** Transactional order, independent of tied wall-clock timestamps. */
  sequence: number;
};
export type PrivateInboxEntry = { threadId: string; peer: MessageParticipant; lastMessage: PrivateMessage; updatedAt: number };
export type PrivateMessagePage = { threadId: string; peer: MessageParticipant; messages: PrivateMessage[]; next: string | null };
export type PrivateInboxPage = { threads: PrivateInboxEntry[]; next: string | null };
export type PrivateMessageSendInput = { clientRequestId: string; body: string };
export type PrivateMessageReceipt = { threadId: string; message: PrivateMessage; replayed: boolean };
