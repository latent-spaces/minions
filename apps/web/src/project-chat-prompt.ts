// The project cheat sheet: the main things to ask a coding chat, one short prompt each, in the person's own words.
// The Minions guide (packages/agent-cli/skills/minions/SKILL.md) holds how each one is done, so the prompts only
// name the action and the project; a new detail goes there, not here.
export const projectCheatSheet = (title: string): [action: string, prompt: string][] => {
  const project = `my Minions project ${JSON.stringify(title)}`;
  return [
    ['Add an agent', `Add an agent to ${project}.`],
    ['Steer an agent', `Tell my agent in ${project} to …`],
    ['Monitor my agents', `Monitor my agents in ${project}.`],
    ['Preview on my computer', `Preview ${project} locally, automatically pulling the latest code and refreshing the preview.`],
    ['See what else you can do', `What else can I do in ${project}?`],
  ];
};
