// The connector is not published: it runs from a checkout of this repository (owner, 10 November 2026).
export const CHECKOUT = 'a checkout of the mylittleswarm repository';
export const CHECKOUT_PREPARE = 'npm ci --ignore-scripts';

// The one command that sets up a computer, run in that checkout. The local engine is the connector's default, so only another website is named.
export function setupCommand(origin: string) {
  const url = new URL(origin);
  // WHATWG URL accepts shell metacharacters in some hostnames. This address is
  // pasted into POSIX and Windows shells, so only a normalized DNS host is safe.
  if (!/^[a-z0-9.-]+$/i.test(url.hostname) || url.pathname !== '/' || url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('Choose a valid MyLittleSwarm address.');
  return `node packages/agent-cli/src/cli.mjs setup${url.origin === 'http://127.0.0.1:8787' ? '' : ` --site ${url.origin}`}`;
}
// Run in the background, setup keeps waiting for the person while the agent posts the messages it writes (such as
// the GitHub sign-in link); in the foreground the agent would see nothing until setup ended. Asking for the
// messages here, in the person's own words, is what makes agents post them rather than retell them.
export const computerSetupInstructions = (origin: string) => `Set up MyLittleSwarm on this computer from ${CHECKOUT}: in it, run ${CHECKOUT_PREPARE}, then run ${setupCommand(origin)} in the background and show me each MyLittleSwarm setup message it writes, exactly as written.`;

// For a computer that is set up but whose gh is not signed in: the Connect GitHub step of the Karma bar.
export const GITHUB_COMMANDS = ['gh auth login --web --git-protocol https --insecure-storage', 'gh auth setup-git'];
export const githubSetupInstructions = () => `Connect GitHub for MyLittleSwarm on this computer: run ${GITHUB_COMMANDS[0]}, then ${GITHUB_COMMANDS[1]}, and guide me through it.`;
