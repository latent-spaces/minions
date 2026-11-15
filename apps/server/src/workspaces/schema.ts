import { z } from 'zod';

export const DEFAULT_WORKSPACE_ID = 'minions';
export const WORKSPACE = z.object({
  schemaVersion: z.literal(1), name: z.string().trim().min(1).max(120),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type Workspace = z.infer<typeof WORKSPACE>;
export const newWorkspaceRecord = (at: number): Workspace => WORKSPACE.parse({ schemaVersion: 1, name: 'Minions', createdAt: at });
