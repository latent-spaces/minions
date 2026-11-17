// Opaque pagination cursors: a base64url JSON array. Each caller validates its own shape.
export function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

export function decodeCursor(cursor: string): unknown[] | null {
  try {
    const values = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    return Array.isArray(values) ? values : null;
  } catch {
    return null;
  }
}
