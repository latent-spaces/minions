/**
 * One `/community/me` lookup per signed-in account: callers on the same page (the project view, the notifications
 * bell, Needs you) share a single request keyed by the user's uid. A failed lookup is forgotten so the next caller,
 * or a retry, asks again; `forget` drops a cached answer (a retry, or a refusal from the service).
 */
export function createProfileLookup() {
  const pending = new Map<string, Promise<string>>();
  const lookup = (uid: string, fetchProfileId: () => Promise<string>): Promise<string> => {
    let answer = pending.get(uid);
    if (!answer) {
      answer = fetchProfileId();
      pending.set(uid, answer);
      answer.catch(() => { if (pending.get(uid) === answer) pending.delete(uid); });
    }
    return answer;
  };
  const forget = (uid: string) => { pending.delete(uid); };
  return { lookup, forget };
}
