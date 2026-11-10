import * as z from 'zod';

// List tools return short rows, 20 at a time; detail: true returns full rows
// (owner direction, 9 November 2026, docs/decisions.md).
export const LIST_PAGE_DEFAULT = 20;
export const LIST_PAGE = {
  limit: z.number().int().min(1).max(100).optional().describe(`Rows per page, 1 to 100 (default ${LIST_PAGE_DEFAULT}).`),
  detail: z.boolean().optional().describe('true returns full rows. Leave it out for short rows.'),
};
