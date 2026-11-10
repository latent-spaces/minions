import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Play } from 'lucide-react';
import { Button } from './Button';
import './project-outputs.css';

/** Shared by member and public-project views. No auth token, message bridge or privileged API enters the frame. */
export function PublishedOutputViewer({ title, url }: { title: string; url: string | null }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [opened, setOpened] = useState<string | null>(null), [frameError, setFrameError] = useState(false);
  useEffect(() => { if (!url) setOpened(null); }, [url]);
  return <>
    <div className="k42-outputs-view-heading"><h3>{title}</h3>{url && <a href={url} target="_blank" rel="noopener noreferrer">Open separately <ExternalLink size={14} aria-hidden="true" /></a>}</div>
    {opened ? <div className="k42-outputs-frame"><iframe ref={frame} tabIndex={0} onLoad={() => frame.current?.focus()} title={`${title} — published output`} src={opened} sandbox="allow-scripts allow-same-origin" allow="fullscreen" allowFullScreen referrerPolicy="no-referrer" onError={() => setFrameError(true)} />
      {frameError && <p role="alert">The output could not be opened. Try opening it separately.</p>}</div>
      : <div className="k42-outputs-placeholder">{url ? <Button className="primary" onClick={() => { setFrameError(false); setOpened(url); }}><Play size={18} aria-hidden="true" />Open output</Button> : <p>No public output yet.</p>}</div>}
    <p>{url ? 'Public output · Last confirmed release' : 'No release published'}</p>
    {opened && url && opened !== url && <Button onClick={() => { setOpened(url); setFrameError(false); }}>Open the new release</Button>}
  </>;
}
