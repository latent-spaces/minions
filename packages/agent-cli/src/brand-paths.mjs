import { existsSync } from 'node:fs';
import path from 'node:path';

// Rebranding must not strand an existing installation or move its credentials.
// New installations use the new name; the former directory is retained only
// when it already exists. Remove this bridge once existing installations migrate.
export function brandedDirectory(userHome, { privateState = true, paths = path, exists = existsSync } = {}) {
  const current = paths.join(userHome, privateState ? '.minions' : 'minions');
  const previous = paths.join(userHome, privateState ? '.mlswarm' : 'mlswarm');
  return exists(previous) && !exists(current) ? previous : current;
}

// Old and new workers must share the same ownership ledger while either is alive.
export function ownershipDirectory(userHome, { exists = existsSync } = {}) {
  const previous = path.join(userHome, '.mlswarm', 'worker-ownership');
  return exists(previous) ? previous : path.join(userHome, '.minions', 'worker-ownership');
}
