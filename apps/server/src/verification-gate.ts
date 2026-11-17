import { Refusal } from './errors.js';
// Resource admission, not an IP identity claim. Valid users behind one proxy share
// neither a minute-long bucket nor cached authorization with invalid callers.
export function boundedVerification(maxPending = 32) {
  let pending = 0;
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (pending >= maxPending) throw new Refusal('rate_limited', 'Sign-in checks are busy. Wait a moment, then try again.', 1);
    pending++;
    try { return await work(); } finally { pending--; }
  };
}
