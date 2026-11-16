import { z } from 'zod';

// Stored on every project, proposal and listing, and queries filter on it, so it keeps its name from before the
// rename to Minions (15 November 2026). Changing it needs a data migration.
export const DEFAULT_WORKSPACE_ID = 'mlswarm';
export const WORKSPACE = z.object({
  schemaVersion: z.literal(1), name: z.string().trim().min(1).max(120),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type Workspace = z.infer<typeof WORKSPACE>;
export const newWorkspaceRecord = (at: number): Workspace => WORKSPACE.parse({ schemaVersion: 1, name: 'Minions', createdAt: at });
