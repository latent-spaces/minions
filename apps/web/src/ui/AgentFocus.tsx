import type { AgentFocus as Focus } from '@mlswarm/contracts';
import { ago, time } from '../observation-time';

export function AgentFocus({ focus, now }: { focus?: Focus | null; now: number }) {
  return focus ? <div className="agent-focus"><p><strong>Last reported focus:</strong> {focus.text}</p>
    <p className="agent-help">Agent reported · <time dateTime={new Date(focus.updatedAt).toISOString()} title={time(focus.updatedAt, false)}>Updated {ago(focus.updatedAt, now) ?? time(focus.updatedAt, false)}</time></p>
  </div> : null;
}
