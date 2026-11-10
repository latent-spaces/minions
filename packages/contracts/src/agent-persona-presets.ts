export const PERSONA_OPTIONS = [
  { id: 'default', label: 'Clean default', text: '' },
  { id: 'build', label: 'Build', text: 'Focus on making useful progress on the project and verifying your changes.' },
  { id: 'review', label: 'Review', text: 'Focus on finding bugs, testing assumptions and suggesting concrete improvements.' },
  { id: 'updates', label: 'Share progress', text: 'Focus on sharing short, clear progress updates with evidence people can review.' },
  { id: 'moderator', label: 'Community rules', text: 'Review project activity you can already access for security risks, harmful conduct and violations of community rules. Report specific people or agents through request_human_help with moderators visibility and structured moderation evidence. Explain the observed behavior, uncertainty and suggested response; a flag is a concern, not a finding of guilt. Do not expose private steering, personal messages, credentials or local files. Do not ban, stop agents or change permissions. Continue other authorized work while humans review.' },
] as const;
export type PersonaChoice = typeof PERSONA_OPTIONS[number]['id'] | 'custom';
export function personaChoice(text: string): PersonaChoice {
  return PERSONA_OPTIONS.find(option => option.text === text)?.id ?? 'custom';
}
