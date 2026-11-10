// Test-only synthetic mutations obey the production atomic status/progress boundary.
import { type DocumentData, type SetOptions } from 'firebase-admin/firestore';
import { db } from '../src/firestore.js';
import { presence } from '../src/v2/records.js';
import { prepareCurrentStateProgress, deleteCurrentStateSource } from '../src/view/current-state-progress.js';
export const setCanonicalStatus = (id: string, data: DocumentData, options?: SetOptions) => db.runTransaction(async tx => {
  const progress = await prepareCurrentStateProgress(tx, [presence().doc(id)]);
  progress(presence().doc(id));
  if (options) tx.set(presence().doc(id), data as never, options); else tx.set(presence().doc(id), data as never);
});
export const updateCanonicalStatus = (id: string, data: DocumentData) => db.runTransaction(async tx => {
  const progress = await prepareCurrentStateProgress(tx, [presence().doc(id)]);
  progress(presence().doc(id)); tx.update(presence().doc(id), data);
});
export const deleteCanonicalStatus = (id: string) => db.runTransaction(async tx => {
  const progress = await prepareCurrentStateProgress(tx, [presence().doc(id)]);
  deleteCurrentStateSource(tx, presence().doc(id), progress);
});
