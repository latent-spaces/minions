import { Bot, Hourglass } from 'lucide-react';
import { projectCheatSheet } from '../project-chat-prompt';
import { CopyCommand } from './ComputerSetup';
import { useMyWorkers } from './MyWorkerControls';

// Until the person has an agent in the project, the cheat sheet's Add an agent prompt for it; otherwise nothing.
export function useAddAgentPrompt(projectName?: string) {
  const workers = useMyWorkers();
  if (!projectName || !workers?.data || workers.data.agents.length || workers.data.queued.length) return undefined;
  return projectCheatSheet(projectName).find(([action]) => action === 'Add an agent')?.[1];
}

/** How to add your first agent: what to ask your coding agent, with a copy button. */
// The heading sits on its own line; an optional note comes before the ask (Noa, 26 October 2026).
export function AddAgentPrompt({ prompt, note }: { prompt: string; note?: string }) {
  return <><p className="k42-add-agent-prompt-text"><strong>Your agent isn't here yet.</strong><span>{note ? `${note} ` : ''}Ask your coding agent:</span></p><CopyCommand command={prompt} label="Copy prompt" /></>;
}

/** The waiting room has no map, so the same prompt sits under the waiting banner. */
// The waiting-room call to action replaces the "starts when the project starts" note (Noa, 27 October 2026).
export function WaitingAddAgent({ projectName, waitingForOwner = false }: { projectName: string; waitingForOwner?: boolean }) {
  const prompt = useAddAgentPrompt(projectName);
  if (!prompt) return null;
  return <section className="k42-notice k42-add-agent-notice" aria-label="Add your agent">
    <span className="k42-notice-icon" aria-hidden="true"><Bot size={20} /></span>
    <div className="k42-notice-text"><AddAgentPrompt prompt={prompt} note={waitingForOwner ? undefined : 'It starts working when the project starts.'} /></div>
  </section>;
}

/** Non-owners in a project that hasn't started: what they are waiting for. The owner has Start project instead. */
export function WaitingRoomCallout() {
  return <section className="k42-notice" aria-label="Waiting room">
    <span className="k42-notice-icon" aria-hidden="true"><Hourglass size={20} /></span>
    <div className="k42-notice-text">
      <h2>Waiting for people and agents to join.</h2>
      <span className="muted">You'll be notified when the owner starts the project.</span>
    </div>
  </section>;
}
