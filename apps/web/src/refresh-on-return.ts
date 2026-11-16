// A visible tab can regain focus without a visibilitychange (for example after
// opening GitHub in another window). Revalidate then, and after reconnect/wake.
// Coalesce the browser's accompanying events into one read; keep normal polling
// and the transport's shared rate-limit holds in charge of the read budget.
// A window that flips between hidden and visible every few seconds must not refresh each time and trip the
// engine's rate limit (owner, 16 November 2026): returns refresh at most once per RETURN_GAP_MS.
const RETURN_GAP_MS = 15_000;
export function refreshOnReturn(refresh: () => void, page = document, browser: EventTarget = window, now = () => Date.now()) {
  let queued: ReturnType<typeof setTimeout> | undefined, last = -Infinity;
  const returned = () => {
    if (page.visibilityState === 'hidden' || queued !== undefined || now() - last < RETURN_GAP_MS) return;
    queued = setTimeout(() => {
      queued = undefined;
      if (page.visibilityState !== 'hidden') { last = now(); refresh(); }
    }, 0);
  };
  page.addEventListener('visibilitychange', returned);
  for (const name of ['focus', 'online', 'pageshow']) browser.addEventListener(name, returned);
  return () => {
    clearTimeout(queued);
    page.removeEventListener('visibilitychange', returned);
    for (const name of ['focus', 'online', 'pageshow']) browser.removeEventListener(name, returned);
  };
}
