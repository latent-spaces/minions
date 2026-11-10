import type { ReactNode, Ref } from 'react';
import { ArrowRight, ChevronDown, ChevronUp, Users } from 'lucide-react';
import type { ConversationRow, MessageRow } from '../api';
import { PersonAvatar } from './PersonAvatar';
import { SteeringDelivery } from './SteeringDelivery';
import { AgentAvatar } from './AgentAvatar';
import { NavLink } from '../shared';
import { projectRoute, type Route } from '../route';
import { fullConversationTitle } from './message-preview';
import './conversations.css';

const name = (agent: { id: string; name: string | null }) => agent.name ?? agent.id;

// Reuse ownership explicitly returned with messages already on this page. No
// directory fetch or assumption that recipients share the sender's person.
export function knownMessageSenders(messages: MessageRow[]) {
  return new Map([...messages].sort((a, b) => a.createdAt - b.createdAt).map(message => [message.sender.id, message.sender]));
}

/** Each message supplies its own direction; badges use only observed ownership. */
export function MessageDirection({ message, projectId, go, senders, deliveryDetails=true }: { message: MessageRow; deliveryDetails?: boolean; projectId?: string; go?: (route: Route) => void; senders?: ReadonlyMap<string, MessageRow['sender']> }) {
  const multiple = message.audience.kind === 'direct' && message.audience.to.length > 1;
  const identity = (agent: MessageRow['sender'], sender: boolean) => {
    if(agent.kind==='person')return <span className="conversation-agent"><PersonAvatar name={agent.name} id={agent.id} photo={agent.photo} size={40}/><span>{name(agent)}</span></span>;
    const owner = sender ? agent : senders?.get(agent.id);
    const ownerLabel = owner?.operatorId ? `Agent of ${owner?.operatorName ?? 'a removed person'}` : null;
    const compact = multiple && !sender;
    const content = <><span className="conversation-portrait" title={`${name(agent)}${ownerLabel ? ` · ${ownerLabel}` : ''}`}><AgentAvatar id={agent.id} name={name(agent)} ownerId={owner?.operatorId} ownerName={owner?.operatorId ? owner.operatorName : undefined} ownerPhoto={owner?.operatorPhoto} size={compact ? 32 : 40} decorative /></span><span className={compact ? 'visually-hidden' : undefined}>{name(agent)}{ownerLabel && <span className="visually-hidden">, {ownerLabel}</span>}</span></>;
    return projectId && go ? <NavLink className="conversation-agent" to={projectRoute(projectId, 'agents', agent.id, null, 'all')} go={go}>{content}</NavLink>
      : <span className="conversation-agent">{content}</span>;
  };
  return <><span className={`conversation-direction${multiple ? ' has-multiple' : ''}`}>
    {identity(message.sender, true)}<span className="conversation-arrow"><ArrowRight size={16} aria-hidden="true" /><span className="visually-hidden">to</span></span>
    {message.audience.kind === 'project' ? <span className="conversation-agent"><Users size={24} aria-hidden="true" /><span>Whole project</span></span>
      : message.audience.to.length===0 ? <span className="conversation-agent">Conversation reply</span> : <span className="conversation-recipient-group"><span className={`conversation-recipients${multiple ? ' is-multiple' : ''}`}>{message.audience.to.map((agent, index) => <span key={agent.id}>{index > 0 && <span className="visually-hidden">and </span>}{identity(agent, false)}</span>)}</span>{multiple && <span className="conversation-recipient-count">{message.audience.to.length} recipients</span>}</span>}
  </span>{message.steering&&<SteeringDelivery {...message.steering} details={deliveryDetails}/>}</>;
}

export function ConversationCard({ conversation, observedMessage, title, metadata, preview, expanded, controls, toggleRef, onToggle, children, senders }: {
  conversation: ConversationRow | null; observedMessage?: MessageRow | null; title: string; metadata: ReactNode; preview?: string; expanded: boolean; controls: string;
  senders?: ReadonlyMap<string, MessageRow['sender']>; toggleRef?: Ref<HTMLButtonElement>; onToggle: () => void; children?: ReactNode;
}) {
  const message = conversation?.first ?? conversation?.latest ?? observedMessage;
  const titleMessage = conversation?.first ?? observedMessage;
  const fullTitle = titleMessage ? fullConversationTitle(titleMessage.body, titleMessage.summary) : title;
  const direction = message ? `${conversation?.first === null ? 'Latest message' : 'First message'}: ${name(message.sender)} to ${message.audience.kind === 'project' ? 'Whole project' : message.audience.to.map(name).join(', ')}` : null;
  return <article className={`conversation-card${expanded ? ' is-expanded' : ''}`}>
    <h3 className="conversation-card-heading"><button type="button" ref={toggleRef} className="conversation-toggle" aria-expanded={expanded} aria-controls={controls}
      aria-describedby={direction ? `${controls}-direction` : undefined} aria-label={`${expanded ? 'Hide' : 'Show'} conversation: ${title}`} onClick={onToggle}>
      {direction && <span id={`${controls}-direction`} className="visually-hidden">{direction}</span>}
      <span className="conversation-summary">{message && <MessageDirection message={message} senders={senders} deliveryDetails={false} />}<span className="conversation-topic"><strong className="conversation-title" title={fullTitle}>{title}</strong><span className="conversation-row-meta">{metadata}</span>{!expanded && preview && <span className="conversation-snippet">{preview}</span>}</span></span>
      <span className="conversation-disclosure">{expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}<span>{expanded ? 'Hide conversation' : 'Show conversation'}</span></span>
    </button></h3>
    <div id={controls} hidden={!expanded}>{children}</div>
  </article>;
}
