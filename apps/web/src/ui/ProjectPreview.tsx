import { useEffect, useRef, useState } from 'react';
import { ExternalLink, MonitorPlay, MonitorX } from 'lucide-react';
import { EmptyState } from './EmptyState';
import './project-preview.css';

// How often a local preview is checked while the tab is open, so a stopped server shows as stopped and a
// restarted one comes back by itself.
export const LOCAL_PREVIEW_CHECK_MS = 10_000;
type Reach = 'checking' | 'up' | 'down';

// Whether anything answers at a local preview address. A no-cors request resolves for any reply and fails only
// when nothing listens; it reads nothing from the page and sends no credentials.
export async function localPreviewAnswers(url: string, fetchImpl: typeof fetch = fetch) {
  try { await fetchImpl(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5_000) }); return true; }
  catch { return false; }
}

// The Preview tab: the page an agent set to show live work, such as a local game (owner, 10 November 2026).
// It loads as soon as the tab opens and follows a new link (owner, 11 November 2026).
// No auth token, message bridge or privileged API enters the frame, and a page on this app's own origin is never framed.
// A local preview whose server has stopped shows a clear state instead of a broken frame (owner, 13 November 2026).
export function ProjectPreview({ title, url, appOrigin, checkLocal = localPreviewAnswers }: { title: string; url: string | null; appOrigin: string; checkLocal?: (url: string) => Promise<boolean> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [frameError, setFrameError] = useState(false);
  const local = !!url && url.startsWith('http:');
  const [reach, setReach] = useState<Reach>('checking');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setFrameError(false), [url]);
  const framable = !!url && new URL(url).origin !== appOrigin;
  useEffect(() => {
    if (!url || !local || !framable) return;
    let active = true;
    setReach('checking');
    const check = () => { void checkLocal(url).then(up => { if (active) setReach(up ? 'up' : 'down'); }); };
    check();
    const timer = setInterval(check, LOCAL_PREVIEW_CHECK_MS);
    return () => { active = false; clearInterval(timer); };
  }, [url, local, framable, checkLocal, attempt]);
  const shown = framable && (!local || reach === 'up');
  return <section className="k42-preview k42-grow">
    <div className="k42-preview-heading"><h2 className="k42-section-title">Preview</h2>{url && <a href={url} target="_blank" rel="noopener noreferrer">Open separately <ExternalLink size={14} aria-hidden="true" /></a>}</div>
    {url && <p className="k42-preview-url">{url}{local ? ' · runs on this computer' : ''}</p>}
    {shown ? <div className="k42-preview-frame"><iframe ref={frame} tabIndex={0} onLoad={() => frame.current?.focus()} title={`${title} — preview`} src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock" allow="fullscreen; gamepad" allowFullScreen referrerPolicy="no-referrer" onError={() => setFrameError(true)} />
      {frameError && <p role="alert">The preview could not be opened. Try opening it separately.</p>}</div>
      : framable && reach === 'checking' ? <div className="k42-preview-placeholder"><p role="status">Looking for the preview…</p></div>
      : framable ? <PreviewStopped checkAgain={() => setAttempt(value => value + 1)} />
      : url ? <div className="k42-preview-placeholder"><p>This preview opens separately.</p></div>
      // An empty tab gets the large empty state, like other empty pages (owner, 11 November 2026).
      : <EmptyState icon={MonitorPlay} size="large" title="No preview yet">When an agent has something running you can try, like a game or a site, it shows here.</EmptyState>}
  </section>;
}

// A local preview where nothing answers: what happened and what to do, instead of the browser's broken frame.
export function PreviewStopped({ checkAgain }: { checkAgain: () => void }) {
  return <div className="k42-preview-stopped" role="status">
    <EmptyState icon={MonitorX} size="large" tone={null} title="The preview isn’t running"
      action={<button type="button" onClick={checkAgain}>Check again</button>}>
      Nothing answers at this address on this computer. The server that showed it may have stopped when an agent’s run ended,
      or it runs on another person’s computer. Ask an agent working on the project to show the preview again; it appears here as soon as it answers.
    </EmptyState></div>;
}
