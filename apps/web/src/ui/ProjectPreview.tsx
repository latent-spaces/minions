import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Play } from 'lucide-react';
import { Button } from './Button';
import './project-preview.css';

// The Preview tab: the page an agent set to show live work, such as a local game (owner, 10 November 2026).
// No auth token, message bridge or privileged API enters the frame, and a page on this app's own origin is never framed.
export function ProjectPreview({ title, url, appOrigin }: { title: string; url: string | null; appOrigin: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [opened, setOpened] = useState<string | null>(null), [frameError, setFrameError] = useState(false);
  useEffect(() => { if (!url) setOpened(null); }, [url]);
  const framable = !!url && new URL(url).origin !== appOrigin;
  return <section className="k42-preview">
    <div className="k42-preview-heading"><h2>Preview</h2>{url && <a href={url} target="_blank" rel="noopener noreferrer">Open separately <ExternalLink size={14} aria-hidden="true" /></a>}</div>
    {opened ? <div className="k42-preview-frame"><iframe ref={frame} tabIndex={0} onLoad={() => frame.current?.focus()} title={`${title} — preview`} src={opened} sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock" allow="fullscreen; gamepad" allowFullScreen referrerPolicy="no-referrer" onError={() => setFrameError(true)} />
      {frameError && <p role="alert">The preview could not be opened. Try opening it separately.</p>}</div>
      : <div className="k42-preview-placeholder">{framable
        ? <Button className="primary" onClick={() => { setFrameError(false); setOpened(url); }}><Play size={18} aria-hidden="true" />Open preview</Button>
        : <p>{url ? 'This preview opens separately.' : 'No preview yet. When an agent has something running you can try, like a game or a site, it shows here.'}</p>}</div>}
    {url && <p className="k42-preview-url">{url}{url.startsWith('http:') ? ' · runs on the agent’s computer while the agent keeps it running' : ''}</p>}
    {opened && url && opened !== url && <Button onClick={() => { setOpened(url); setFrameError(false); }}>Open the new preview</Button>}
  </section>;
}
