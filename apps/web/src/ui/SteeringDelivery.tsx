import type { MessageRow } from '../api';
export const steeringLabels={queued:'Queued',received:'Delivered to computer',included:'Included in a turn',uncertain:'Delivery unconfirmed',ended:'Run ended before inclusion'};
type Props = NonNullable<MessageRow['steering']> & {details?:boolean};
export function SteeringDelivery({state,origin,deliveries,details=true}:Props) {
  const via=`Steering · via ${origin==='coding_chat'?'coding chat':'local app'}`;
  if(!deliveries)return <span className="muted">{via} · {steeringLabels[state]}</span>;
  const summary=Object.entries(steeringLabels).flatMap(([key,label])=>{const count=deliveries.filter(d=>d.state===key).length;return count?[`${label}: ${count}`]:[];}).join(' · ');
  if(!details)return <span className="muted">{via} · {summary}</span>;
  return <details className="steering-delivery"><summary>{via} · {summary}<span className="steering-delivery-hint">Delivery details</span></summary>
    <ul>{deliveries.map(d=><li key={d.agentId}><span>{d.agentName??d.agentId}</span><span>{steeringLabels[d.state]}</span></li>)}</ul>
  </details>;
}
