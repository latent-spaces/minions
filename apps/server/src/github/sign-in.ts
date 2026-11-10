import { z } from 'zod';
import { profileForEmails } from '../auth.js';
import { Refusal } from '../errors.js';
import { profiles } from '../firestore.js';
import { normalizeEmails } from '../identity/emails.js';
import { GITHUB_USERNAME } from '../projects/github-username.js';

// During GitHub sign-in (github/oauth.ts) the server asks GitHub itself which emails the account has verified,
// and which username it has.
/** A testable transport; production always calls api.github.com. */
export const githubApiTransport = { fetch: (url: string, init: RequestInit) => fetch(url, init) };
const USER = z.object({ id: z.number().int().positive(), login: GITHUB_USERNAME, name: z.string().max(256).nullable().optional().catch(null), avatar_url: z.string().max(2048).nullable().optional() });
const EMAILS = z.array(z.object({ email: z.string().max(254), verified: z.boolean(), primary: z.boolean() })).max(100);
const refused = () => new Refusal('unauthorized', 'GitHub didn’t confirm this sign-in. Sign in again.');
const unavailable = () => new Error('GitHub sign-in verification is temporarily unavailable.');

async function github(path: string, accessToken: string): Promise<unknown> {
  const response = await githubApiTransport.fetch(`https://api.github.com${path}`, { redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'mlswarm' } })
    .catch(() => { throw unavailable(); });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 429 || response.status >= 500 || response.status === 403
      && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0')) throw unavailable();
    throw refused();
  }
  return response.json().catch(() => { throw refused(); });
}

export type ConfirmedGithubAccount = { githubId: string; login: string; name: string | null; avatarUrl: string | null; emails: string[] };

/** Asks GitHub itself which account an access token belongs to and which emails it has verified, primary first. */
export async function confirmGithubAccount(accessToken: string): Promise<ConfirmedGithubAccount> {
  const [user, emails] = await Promise.all([github('/user', accessToken), github('/user/emails', accessToken)])
    .then(([user, emails]) => [USER.safeParse(user), EMAILS.safeParse(emails)] as const);
  if (!user.success || !emails.success) throw refused();
  const verified = normalizeEmails(emails.data.filter(e => e.verified).sort((a, b) => Number(b.primary) - Number(a.primary)).map(e => e.email));
  return { githubId: String(user.data.id), login: user.data.login, name: user.data.name ?? null, avatarUrl: user.data.avatar_url ?? null, emails: verified };
}
export const unverified = () => new Refusal('unauthorized', 'Verify an email on your GitHub account, then sign in again.');

/** The profile's GitHub username follows the account the person signs in with. */
export async function followGithubUsername(account: Pick<ConfirmedGithubAccount, 'login' | 'emails'>): Promise<void> {
  const person = await profileForEmails(account.emails);
  if (person && person.githubUsername !== account.login) await profiles.doc(person.id).update({ githubUsername: account.login });
}
