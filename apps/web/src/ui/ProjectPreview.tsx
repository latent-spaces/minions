import { useEffect, useRef, useState } from 'react';
import { ExternalLink, MonitorPlay } from 'lucide-react';
import { EmptyState } from './EmptyState';
import './project-preview.css';

// The Preview tab: the page an agent set to show live work, such as a local game (owner, 10 November 2026).
// It loads as soon as the tab opens and follows a new link (owner, 11 November 2026).
// No auth token, message bridge or privileged API enters the frame, and a page on this app's own origin is never framed.
export function ProjectPreview({ title, url, appOrigin }: { title: string; url: string | null; appOrigin: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [frameError, setFrameError] = useState(false);
  useEffect(() => setFrameError(false), [url]);
  const framable = !!url && new URL(url).origin !== appOrigin;
  return <section className="k42-preview k42-grow">
    <div className="k42-preview-heading"><h2 className="k42-section-title">Preview</h2>{url && <a href={url} target="_blank" rel="noopener noreferrer">Open separately <ExternalLink size={14} aria-hidden="true" /></a>}</div>
    {url && <p className="k42-preview-url">{url}{url.startsWith('http:') ? ' · runs on the agent’s computer while the agent keeps it running' : ''}</p>}
    {framable ? <div className="k42-preview-frame"><iframe ref={frame} tabIndex={0} onLoad={() => frame.current?.focus()} title={`${title} — preview`} src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock" allow="fullscreen; gamepad" allowFullScreen referrerPolicy="no-referrer" onError={() => setFrameError(true)} />
      {frameError && <p role="alert">The preview could not be opened. Try opening it separately.</p>}</div>
      : url ? <div className="k42-preview-placeholder"><p>This preview opens separately.</p></div>
      // An empty tab gets the large empty state, like other empty pages (owner, 11 November 2026).
      : <EmptyState icon={MonitorPlay} size="large" title="No preview yet">When an agent has something running you can try, like a game or a site, it shows here.</EmptyState>}
  </section>;
}
