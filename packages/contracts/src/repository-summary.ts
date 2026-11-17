/** Read-only counts from approved owner/admin computers, never live GitHub totals. */
export type RepositorySummary =
  | { status: 'unavailable'; repository: string }
  | { status: 'observed'; repository: string; open: number; merged: number | null;
      lastSyncAt: number | null; syncFailed: boolean };
