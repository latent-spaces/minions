// A visible tab can regain focus without a visibilitychange (for example after
// opening GitHub in another window). Revalidate then, and after reconnect/wake.
// Coalesce the browser's accompanying events into one read; keep normal polling
// and the transport's shared rate-limit holds in charge of the read budget.
export function refreshOnReturn(refresh: () => void, page = document, browser: EventTarget = window) {
  let queued: ReturnType<typeof setTimeout> | undefined;
  const returned = () => {
    if (page.visibilityState === 'hidden' || queued !== undefined) return;
    queued = setTimeout(() => {
      queued = undefined;
      if (page.visibilityState !== 'hidden') refresh();
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
