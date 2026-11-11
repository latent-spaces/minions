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

/** Each message supplies its own direction; the server sends every sender's and recipient's owner and persona. */
export function MessageDirection({ message, projectId, go, deliveryDetails=true }: { message: MessageRow; deliveryDetails?: boolean; projectId?: string; go?: (route: Route) => void }) {
  const multiple = message.audience.kind === 'direct' && message.audience.to.length > 1;
  const identity = (agent: MessageRow['sender'] | Extract<MessageRow['audience'], {kind:'direct'}>['to'][number], sender: boolean) => {
    if('kind' in agent && agent.kind==='person')return <span className="conversation-agent"><PersonAvatar name={agent.name} id={agent.id} photo={agent.photo} size={40}/><span>{name(agent)}</span></span>;
    const ownerLabel = agent.operatorId ? `Agent of ${agent.operatorName ?? 'a removed person'}` : null;
    const compact = multiple && !sender;
    const content = <><span className="conversation-portrait" title={`${name(agent)}${ownerLabel ? ` · ${ownerLabel}` : ''}`}><AgentAvatar id={agent.id} name={name(agent)} ownerId={agent.operatorId} ownerName={agent.operatorId ? agent.operatorName : undefined} persona={agent.personaChoice} size={compact ? 32 : 40} decorative /></span><span className={compact ? 'visually-hidden' : undefined}>{name(agent)}{ownerLabel && <span className="visually-hidden">, {ownerLabel}</span>}</span></>;
    return projectId && go ? <NavLink className="conversation-agent" to={projectRoute(projectId, 'agents', agent.id, null, 'all')} go={go}>{content}</NavLink>
      : <span className="conversation-agent">{content}</span>;
  };
  return <><span className={`conversation-direction${multiple ? ' has-multiple' : ''}`}>
    {identity(message.sender, true)}<span className="conversation-arrow"><ArrowRight size={16} aria-hidden="true" /><span className="visually-hidden">to</span></span>
    {message.audience.kind === 'project' ? <span className="conversation-agent"><Users size={24} aria-hidden="true" /><span>Whole project</span></span>
      : message.audience.to.length===0 ? <span className="conversation-agent">Conversation reply</span> : <span className="conversation-recipient-group"><span className={`conversation-recipients${multiple ? ' is-multiple' : ''}`}>{message.audience.to.map((agent, index) => <span key={agent.id}>{index > 0 && <span className="visually-hidden">and </span>}{identity(agent, false)}</span>)}</span>{multiple && <span className="conversation-recipient-count">{message.audience.to.length} recipients</span>}</span>}
  </span>{message.steering&&<SteeringDelivery {...message.steering} details={deliveryDetails}/>}</>;
}

export function ConversationCard({ conversation, observedMessage, title, metadata, preview, expanded, controls, toggleRef, onToggle, children }: {
  conversation: ConversationRow | null; observedMessage?: MessageRow | null; title: string; metadata: ReactNode; preview?: string; expanded: boolean; controls: string;
  toggleRef?: Ref<HTMLButtonElement>; onToggle: () => void; children?: ReactNode;
}) {
  const message = conversation?.first ?? conversation?.latest ?? observedMessage;
  const titleMessage = conversation?.first ?? observedMessage;
  const fullTitle = titleMessage ? fullConversationTitle(titleMessage.body, titleMessage.summary) : title;
  const direction = message ? `${conversation?.first === null ? 'Latest message' : 'First message'}: ${name(message.sender)} to ${message.audience.kind === 'project' ? 'Whole project' : message.audience.to.map(name).join(', ')}` : null;
  return <article className={`conversation-card${expanded ? ' is-expanded' : ''}`}>
    <h3 className="conversation-card-heading"><button type="button" ref={toggleRef} className="conversation-toggle" aria-expanded={expanded} aria-controls={controls}
      aria-describedby={direction ? `${controls}-direction` : undefined} aria-label={`${expanded ? 'Hide' : 'Show'} conversation: ${title}`} onClick={onToggle}>
      {direction && <span id={`${controls}-direction`} className="visually-hidden">{direction}</span>}
      <span className="conversation-summary">{message && <MessageDirection message={message} deliveryDetails={false} />}<span className="conversation-topic"><strong className="conversation-title" title={fullTitle}>{title}</strong><span className="conversation-row-meta">{metadata}</span>{!expanded && preview && <span className="conversation-snippet">{preview}</span>}</span></span>
      <span className="conversation-disclosure">{expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}<span>{expanded ? 'Hide conversation' : 'Show conversation'}</span></span>
    </button></h3>
    <div id={controls} hidden={!expanded}>{children}</div>
  </article>;
}
