import { CodingAgentAvatar } from './CodingAgentAvatar';
import type { TaskAgent } from './ProjectTasks';

/** A task or team agent's face with its coding tool and live state, when the first agents page knows them. */
export function TaskAgentAvatar({ id, name, agent, size, hideState = false }: { id: string; name: string; agent?: TaskAgent; size?: number; hideState?: boolean }) {
  return <CodingAgentAvatar id={id} name={name} ownerId={agent?.operatorId} ownerName={agent?.operatorName} persona={agent?.personaChoice}
    provider={agent?.provider} status={!hideState && agent?.state ? { state: agent.state } : undefined} size={size} decorative />;
}
