// Who may approve and merge pull requests into the main branch, as the service stores it on the project Card.
// The web app no longer edits it; agents read it from the Card.
export type MergeApproval = 'humans' | 'other_agents' | 'agent_review' | 'anyone';
