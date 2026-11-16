import { useRealtimeTick, RECONCILE_MS } from './realtime';
// Agent conversations expand in place. Each message retains its recorded sender,
// audience and full body; reading never delivers messages or starts model work.
import type { SessionUser } from './session-identity';
import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { read, ProjectScope, type ConversationRow, type MessageRow } from './api';
import { Since } from './Agents';
import type { Route } from './route';
import { Pager, usePages } from './shared';
import { ChatBody, ChatTimeline } from './ui/ChatTimeline';
import { useChatHistory } from './useChatHistory';
import { Button } from './ui/Button';
import { chatMessageRoute } from './chat-api';
import { ChatSearch, LinkedChatMessage, useChatUnread, useThreadUnreadCounts } from './ui/ChatFeatures';
import { RotateCw, MessagesSquare, Pin } from './ui/icons';
import type { HumanRequest } from '@minions/contracts';
import { WaitingRequests } from './ui/NeedsYou';
import { conversationTitle, messagePreview } from './ui/message-preview';
import { EmptyState } from './ui/EmptyState';
import { InfoTip } from './ui/InfoTip';
import { ConversationCard, MessageDirection } from './ui/ConversationCard';

const threadRoute = (projectId: string, thread: string | null): Route => ({ view: 'project', projectId, section: 'conversations', thread, agent: null, q: null });
export const opening = conversationTitle;

type Props = { user: SessionUser | null; thread: string | null; messageId?: string; tick: number; active: boolean; go: (to: Route) => void; requests?: HumanRequest[]; readOnly?: boolean };
export function Conversations(props: Props) {
  const projectId = useContext(ProjectScope);
  return <ConversationList key={`${props.user?.uid ?? 'guest'}:${projectId}`} {...props} />;
}

function ConversationList({ user, thread, messageId, tick, active, go, requests = [], readOnly = false }: Props) {
  const projectId = useContext(ProjectScope), contentId = useId();
  const liveTick = useRealtimeTick(user, projectId, 'conversations', active);
  const conversationsPath = (cursor: string | null) => '/conversations' + (cursor ? '?' + new URLSearchParams({ cursor }) : '');
  const heading = useRef<HTMLHeadingElement>(null), toggles = useRef(new Map<string, HTMLButtonElement>());
  const [observedRoot, setObservedRoot] = useState<{ id: string; message: MessageRow | null } | null>(null);
  const receiveRoot = useCallback((id: string, message: MessageRow | null) => setObservedRoot({ id, message }), []);
  // A directly opened thread keeps one mounted history while the directory
  // arrives. Otherwise moving it into a fetched list would restart its reads.
  const anchored = useRef(thread);
  if (!thread) anchored.current = null;
  const previous = useRef(thread);
  useEffect(() => {
    const before = previous.current; previous.current = thread;
    if (before && !thread) (toggles.current.get(before) ?? heading.current)?.focus({ preventScroll: true });
  }, [thread]);
  const { page, error, first, older, newer } = usePages<ConversationRow>(user, conversationsPath, tick + liveTick, active);
  const now = page?.serverTime ?? Date.now();
  const unreadCounts = useThreadUnreadCounts(user, projectId, active, page?.items.map(c => c.threadId) ?? []);
  const search = useCallback((query: string, cursor: string | null) => read<{ messages: MessageRow[]; next: string | null; scanned: number }>(user, '/conversations/search?q=' + encodeURIComponent(query) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), projectId), [user, projectId]);
  // Polling can update metadata, but cannot move an open card while it is being
  // read. Keep IDs only, so confirmed access loss still clears all private rows.
  const order = useRef<string[]>([]);
  if (!thread) order.current = page?.items.map(c => c.threadId) ?? [];
  if (thread && !order.current.length && page) order.current = page.items.map(c => c.threadId);
  const rank = new Map(order.current.map((id, index) => [id, index]));
  const items = [...(page?.items ?? [])].sort((a, b) => (rank.get(a.threadId) ?? Infinity) - (rank.get(b.threadId) ?? Infinity));
  const separate = !!thread && (anchored.current === thread || !items.some(c => c.threadId === thread));
  const open = (conversation: ConversationRow | null) => {
    const id = conversation?.threadId ?? thread!;
    const expanded = id === thread;
    const root = conversation?.first ?? (observedRoot?.id === id ? observedRoot.message : null);
    const title = root ? opening(root.body, root.summary) : 'Conversation';
    return <ConversationCard conversation={conversation} observedMessage={root} title={title} expanded={expanded} controls={`${contentId}-${id}`}
      toggleRef={element => { if (element) toggles.current.set(id, element); else toggles.current.delete(id); }}
      metadata={<>{conversation && <>{!conversation.first && <span>First message unavailable</span>}<span>{conversation.count} {conversation.count === 1 ? 'message' : 'messages'}</span><span>Latest <Since at={conversation.latest.createdAt} now={now} /></span></>}{!!unreadCounts[id] && <strong>{unreadCounts[id]} unread</strong>}</>}
      preview={conversation?.first?.id !== conversation?.latest.id ? messagePreview(conversation?.latest.body ?? '', conversation?.latest.summary) : undefined}
      onToggle={() => go(threadRoute(projectId, expanded ? null : id))}>
      {expanded && <Thread key={id} user={user} id={id} tick={tick} active={active} go={go} title={title} messageId={messageId} needsRoot={!conversation} onRoot={receiveRoot} />}
    </ConversationCard>;
  };
  return <section aria-labelledby="conversations-title" className="conversations">
    <div className="k42-section-heading conversations-heading"><h2 id="conversations-title" className="k42-section-title" ref={heading} tabIndex={-1}>Communication</h2>
      <InfoTip label="Communication">{user ? 'Messages your agents send each other, your steering, and the messages you send with tasks.' : 'Project-wide conversations. Direct messages stay private.'}</InfoTip></div>
    <section className="conversation-directory" aria-label="Conversation list">
      {(!error || page) && <ChatSearch titleOnly search={search} onSelect={message => go(chatMessageRoute(projectId, 'agent', message.id, message.threadId))} />}
      {/* An agent asking a person for help is a message to them, pinned above the conversations until answered (owner, 12 November 2026). */}
      {user && <WaitingRequests user={user} requests={requests} go={go} readOnly={readOnly} label={<><Pin size={14} aria-hidden="true" />Waiting for an answer{requests.length > 0 && ` · ${requests.length}`}</>} />}
      {error && <p className="error" role="alert">Could not load conversations: {error}</p>}
      {!page && !error && <p className="muted" role="status">Loading conversations…</p>}
      {/* Deep links and older-page threads remain usable even when the selected
          conversation is outside this directory page. Never invent its title. */}
      {separate && open(items.find(c => c.threadId === thread) ?? null)}
      {page?.items.length === 0 && (first
        ? <div className="conversation-empty"><EmptyState icon={MessagesSquare} size="large" title="No conversations yet">Agent messages, new steering and messages you send with tasks appear here.</EmptyState></div>
        : <p className="muted">Older messages belong to conversations on newer pages.</p>)}
      {!!items.length && <ul className="conversation-list">{items.filter(c => !separate || c.threadId !== thread).map(c => <li key={c.threadId}>{open(c)}</li>)}</ul>}
      <Pager first={first} hasNext={!!page?.next} onBack={() => { heading.current?.focus(); newer(); }} onNext={() => { heading.current?.focus(); older(); }} nextLabel="Older conversations" />
    </section>
  </section>;
}

function Thread({ user, id, tick, active, go, title, messageId, needsRoot, onRoot }: { user: SessionUser | null; id: string; tick: number; active: boolean; go: (to: Route) => void; title: string; messageId?: string; needsRoot: boolean; onRoot: (id: string, message: MessageRow | null) => void }) {
  const projectId = useContext(ProjectScope);
  type ThreadPage = { messages: MessageRow[]; next: string | null; serverTime: number; count: number | null };
  const fetchPage = useCallback((cursor: string | null) => read<ThreadPage>(user, `/threads/${id}?order=latest${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, projectId), [user, id, projectId]);
  const liveTick = useRealtimeTick(user, projectId, 'conversations', active);
  const history = useChatHistory<MessageRow, ThreadPage>(fetchPage, active, tick + liveTick, user ? RECONCILE_MS : 5000);
  useEffect(() => {
    if (!needsRoot || !active || history.accessDenied) { onRoot(id, null); return; }
    let current = true;
    void read<{ message: MessageRow }>(user, '/messages/' + encodeURIComponent(id), projectId).then(result => {
      if (current) onRoot(id, result.message?.id === id && result.message.threadId === id ? result.message : null);
    }, () => { if (current) onRoot(id, null); });
    return () => { current = false; };
  }, [user, projectId, id, needsRoot, active, history.accessDenied, onRoot]);
  const unread = useChatUnread(user, projectId, active, id);
  const loadLinked = useCallback(async (message: string) => (await read<{ message: MessageRow }>(user, '/messages/' + encodeURIComponent(message), projectId)).message, [user, projectId]);
  const identity = (message: MessageRow) => <MessageDirection message={message} projectId={projectId} go={go} />;
  if (history.accessDenied) return <section className="conversation-thread"><p role="alert">This conversation is unavailable or your access changed.</p><Button className="primary" onClick={history.reload}><RotateCw size={18} aria-hidden="true" />Check access again</Button></section>;
  return <section className="conversation-thread k42-chat-panel" aria-label={title}>
    <LinkedChatMessage messageId={messageId} load={loadLinked} clear={() => go(threadRoute(projectId, id))} render={message => <>{identity(message)}<ChatBody body={message.body} /></>} />
    {unread.count > 0 && <p className="k42-chat-unread">{unread.count} unread in this conversation</p>}
    {unread.error && <p className="muted" role="status">{unread.error}</p>}
    {(history.error || history.gap) && <div className="k42-chat-feedback" role="status"><p>{history.error ? 'Could not refresh this conversation. Retry to check access and load messages.' : 'More messages arrived than fit in one refresh.'}</p><Button className="soft" disabled={history.busy} onClick={history.gap ? history.bridgeGap : history.reload}>{history.gap ? 'Load missing messages' : 'Try again'}</Button></div>}
    <ChatTimeline fullMessages messages={history.messages} label="Agent message history" loading={!history.page && !history.error} empty="No messages in this conversation." older={() => void history.older()} busy={history.busy} hasOlder={!!history.page?.next} senderKey={message => message.sender.id} renderIdentity={identity} onReadLatest={pointer => void unread.mark(pointer)} />
  </section>;
}
