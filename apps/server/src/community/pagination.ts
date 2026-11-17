import { Refusal } from '../errors.js';
import { decodeCursor, encodeCursor } from '../cursor.js';

export function cursorAfter(cursor: string | undefined, scope: string): string | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 500) throw new Error();
    const decoded = decodeCursor(cursor);
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== scope || typeof decoded[1] !== 'string'
      || !(scope.startsWith('history:') ? /^[0-9]{16}$/ : scope.startsWith('project-members:') ? /^[\w-]{1,200}$/ : /^[a-f0-9]{64}$/).test(decoded[1])) throw new Error();
    return decoded[1];
  } catch { throw new Refusal('bad_input', 'Use the cursor returned for this account and list.'); }
}
export const nextCursor = (scope: string, after: string) => encodeCursor([scope, after]);
