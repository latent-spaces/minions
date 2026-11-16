/** The choices behind the start prompt on My projects. The model and the time stay as in the example. */
export type PromptChoices = { visibility: 'private' | 'public'; agents: number; goal: string };
export const MAX_PROMPT_AGENTS = 10;
export const DEFAULT_PROMPT_CHOICES: PromptChoices = { visibility: 'private', agents: 3, goal: 'a 2D game' };

export function claudePrompt({ visibility, agents, goal }: PromptChoices): string {
  const count = Number.isFinite(agents) ? Math.min(MAX_PROMPT_AGENTS, Math.max(1, Math.round(agents))) : DEFAULT_PROMPT_CHOICES.agents;
  const what = goal.trim().replace(/[.\s]+$/, '') || DEFAULT_PROMPT_CHOICES.goal;
  // It names the skill and Minions, so the coding agent loads the minions skill instead of guessing (owner, 16 November 2026).
  return `Use the minions skill: create a Minions project in a new ${visibility} GitHub repo, and add ${count} Claude Sonnet ${count === 1 ? 'agent' : 'agents'} for 5 minutes to build me ${what}.`;
}
