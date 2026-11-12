import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ProgressPage, ProgressScreenshot, PublishedUpdate } from '@mlswarm/contracts';
import { projectRoute, type Route } from '../route';
import { NavLink } from '../shared';
import { Button } from './Button';
import { CloseButton } from './CloseButton';
import { Dialog } from './Dialog';
import { PersonLink } from './PersonLink';
import { ArrowUp, Expand, Megaphone } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { PersonAvatar } from './PersonAvatar';
import './project-progress.css';

export type ProgressReadProps = {
  projectId: string;
  page: ProgressPage | null;
  loading: boolean;
  error: string | null;
  active?: boolean;
  loadEarlier?: () => Promise<ProgressPage|null>;
  resolveScreenshot: (screenshot: ProgressScreenshot) => Promise<Blob>;
  go: (route: Route) => void;
};
export type ProjectUpdatesProps = ProgressReadProps & { onPendingChange?: (count: number) => void };
const date = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Author({ item, go }: { item: PublishedUpdate; go: ProgressReadProps['go'] }) {
  const person = item.author.profile, agent = item.author.agent;
  return <header className="k42-progress-author">
    {agent ? <AgentAvatar provider={agent.provider} id={agent.id} name={agent.name} ownerName={person.name} ownerId={person.id} size={40} decorative />
      : <PersonAvatar id={person.id} name={person.name || null} photo={person.photo} character={person.character} size={40} />}
    <div className="k42-progress-byline"><div>
      {agent && <><NavLink to={projectRoute(item.projectId, 'agents', agent.id, null, 'all')} go={go}>{agent.name}</NavLink><span className="muted"> · </span></>}
      <PersonLink photo={person.photo} character={person.character} id={person.id} name={person.name} />
    </div><time dateTime={new Date(item.publishedAt).toISOString()}>{date(item.publishedAt)}</time></div>
  </header>;
}
function Links({ item }: { item: PublishedUpdate }) {
  return item.links.length ? <ul className="k42-progress-links">{item.links.map((link, index) => <li key={index}>
    <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a><span className="muted">{link.purpose === 'result' ? 'Result link' : 'Evidence link'}</span>
  </li>)}</ul> : null;
}
function UpdateBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const characters = [...body];
  const long = characters.length > 150;
  return <>
    <p id={id} className="k42-progress-body">{long && !expanded ? characters.slice(0, 150).join('') + '…' : body}</p>
    {long && <Button type="button" className="soft k42-progress-body-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show more'}</Button>}
  </>;
}
function Screenshot({ item, resolve }: { item: PublishedUpdate; resolve: ProgressReadProps['resolveScreenshot'] }) {
  const screenshot = item.screenshot;
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const previewId = useId();
  const [image, setImage] = useState<{ id: string; url: string | null; error: boolean; loaded: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  const container = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!screenshot || !container.current) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [screenshot?.id]);
  useEffect(() => {
    if (!screenshot || !visible) return;
    let cancelled = false, objectUrl: string | null = null;
    setImage({ id: screenshot.id, url: null, error: false, loaded: false });
    void resolve(screenshot).then(blob => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setImage({ id: screenshot.id, url: objectUrl, error: false, loaded: false });
    }, () => { if (!cancelled) setImage({ id: screenshot.id, url: null, error: true, loaded: false }); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [screenshot?.id, resolve, retry, visible]);
  if (!screenshot) return null;
  const shown = image?.id === screenshot.id ? image : null;
  return <figure ref={container} className="k42-progress-preview">
    <div className="k42-progress-image-frame" style={{ aspectRatio: `${screenshot.width} / ${screenshot.height}` }}>
      {shown?.error ? <div className="k42-progress-image-state"><p>Could not load this image.</p><Button type="button" className="soft" onClick={() => setRetry(value => value + 1)}>Retry image</Button></div> : <>
        {!shown?.loaded && <div className="k42-progress-image-state k42-progress-image-loading" role="status"><span className="visually-hidden">Loading image…</span></div>}
        {shown?.url && <button ref={trigger} type="button" className="k42-progress-image-open" style={{ visibility: shown.loaded ? 'visible' : 'hidden' }} aria-label={`Enlarge image: ${screenshot.alt}`} onClick={() => dialog.current?.showModal()}>
          <img loading="lazy" decoding="async" src={shown.url} width={screenshot.width} height={screenshot.height} alt={screenshot.alt}
            onLoad={() => setImage(current => current?.id === screenshot.id ? { ...current, loaded: true } : current)}
            onError={() => setImage(current => current?.id === screenshot.id ? { ...current, error: true, loaded: false } : current)} />
          <span className="k42-progress-expand" aria-hidden="true"><Expand size={18} /></span>
        </button>}
      </>}
    </div>
    <figcaption><span>{screenshot.representation === 'concept_image' ? 'Concept image' : 'Author-uploaded screenshot'}</span>{screenshot.caption && <span>{screenshot.caption}</span>}</figcaption>
    <Dialog ref={dialog} className="k42-progress-image-dialog" aria-labelledby={previewId} onClose={() => trigger.current?.focus({ preventScroll: true })}>
      <h2 id={previewId} className="visually-hidden">Image preview</h2>
      {shown?.url && <img src={shown.url} width={screenshot.width} height={screenshot.height} alt={screenshot.alt} />}
      <p>{screenshot.alt}{screenshot.caption && <> · {screenshot.caption}</>}</p>
      <CloseButton label="Close image preview" onClick={() => dialog.current?.close()} />
    </Dialog>
  </figure>;
}

export function ProjectUpdates(props: ProjectUpdatesProps) {
  return <ScopedProjectUpdates key={props.projectId} {...props}/>;
}
function ScopedProjectUpdates(props: ProjectUpdatesProps) {
  const items = props.page?.items.filter(item => item.projectId === props.projectId) ?? [];
  const [head, setHead] = useState<string | null>(items[0]?.id ?? null);
  const [waitingOlder, setWaitingOlder] = useState(false), [historyError, setHistoryError] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null), bottom = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const atTop = useRef(true), loadLock = useRef(false), automaticCursor = useRef<string | null>(null);
  const active = props.active !== false;
  const pending = head ? Math.max(0, items.findIndex(item => item.id === head)) : 0;
  const shown = items.slice(pending);
  useEffect(() => { props.onPendingChange?.(pending); }, [pending, props.onPendingChange]);
  useEffect(() => () => { props.onPendingChange?.(0); }, [props.onPendingChange]);
  // Keep the first visible identity stable while someone reads. Polling can add
  // posts to the head without inserting DOM above their current position.
  useEffect(() => {
    if (!head || !items.length || atTop.current) setHead(items[0]?.id ?? null);
  }, [props.page, head]);
  useEffect(() => {
    if (!active || !top.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => { atTop.current = entries[0].isIntersecting; });
    observer.observe(top.current);
    return () => observer.disconnect();
  }, [active]);
  const earlier = useCallback(async () => {
    if (!active || !props.page?.next || !props.loadEarlier || props.loading || loadLock.current) return;
    loadLock.current = true; setWaitingOlder(true); setHistoryError(null);
    try {
      const next = await props.loadEarlier();
      if (!next) setHistoryError('Could not load earlier updates. Try again.');
    } catch { setHistoryError('Could not load earlier updates. Try again.'); }
    finally { loadLock.current = false; setWaitingOlder(false); }
  }, [active, props.page?.next, props.loadEarlier, props.loading]);
  useEffect(() => {
    if (!active || !bottom.current || !props.page?.next || props.loading || waitingOlder || historyError || props.error || typeof IntersectionObserver === 'undefined') return;
    const cursor = props.page.next;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && automaticCursor.current !== cursor) {
        automaticCursor.current = cursor; void earlier();
      }
    }, { rootMargin: '300px' });
    observer.observe(bottom.current);
    return () => observer.disconnect();
  }, [active, props.page?.next, props.loading, props.error, waitingOlder, historyError, earlier]);
  return <section className="k42-project-updates" aria-labelledby={'updates-' + props.projectId}>
    <div ref={top} className="k42-progress-top" aria-hidden="true" />
    <header className="k42-progress-heading"><div><h2 ref={heading} tabIndex={-1} id={'updates-' + props.projectId}>Project updates</h2>
      <p className="muted">Your agents post here as they work.</p></div></header>
    {pending > 0 && <div className="k42-progress-arrivals" aria-live="polite" aria-atomic="true"><Button type="button" className="primary" onClick={() => {
      setHead(items[0]?.id ?? null); top.current?.scrollIntoView({ block: 'start' }); heading.current?.focus({ preventScroll: true });
    }}><ArrowUp size={16} aria-hidden="true" />{pending} new {pending === 1 ? 'update' : 'updates'}</Button></div>}
    {props.error && !historyError && <p className="error" role="alert">{props.error}</p>}
    <div className="k42-progress-posts">
      {shown.map(item => <article key={item.id} className="k42-progress-update" aria-label={item.title || 'Project update'}>
        <Author item={item} go={props.go} />
        <Screenshot item={item} resolve={props.resolveScreenshot} />
        <div className="k42-progress-copy">{item.title && <h3>{item.title}</h3>}<UpdateBody body={item.body} /><Links item={item} /></div>
      </article>)}
      {!shown.length && (props.loading ? <div className="k42-progress-empty" role="status">Loading updates…</div> : <div className="k42-progress-empty"><span className="k42-progress-empty-icon" aria-hidden="true"><Megaphone size={18} /></span><strong>No updates yet.</strong></div>)}
    </div>
    {historyError && <p className="error" role="alert">{historyError}</p>}
    <div ref={bottom} className="k42-progress-more">
      {shown.length > 0 && props.page?.next && props.loadEarlier && <Button type="button" className="soft" disabled={!active || waitingOlder || props.loading} onClick={() => void earlier()}>{waitingOlder ? 'Loading earlier updates…' : historyError ? 'Retry earlier updates' : 'Load earlier updates'}</Button>}
      {shown.length > 0 && !props.page?.next && <p className="muted">{pending ? 'Earlier updates end here.' : 'You’re all caught up.'}</p>}
    </div>
  </section>;
}
