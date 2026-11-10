import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { profiles } from '../src/firestore.js';
import { personIdentityFromIdToken } from '../src/auth.js';
import { confirmGithubAccount, followGithubUsername, githubApiTransport } from '../src/github/sign-in.js';
import { issueGithubSession } from '../src/identity/server-sessions.js';
import { resetEmulator } from './helpers.js';

const now = () => Date.now();
const person = { name: 'Person', email: 'person@example.test', removedAt: null };
// GitHub's answers for the access token the sign-in exchanged.
function github(user: object, emails: object[]) {
  return vi.spyOn(githubApiTransport, 'fetch').mockImplementation(async url => new Response(JSON.stringify(url.endsWith('/user/emails') ? emails : user)));
}
beforeEach(async () => { await resetEmulator(); await profiles.doc('person').set(person); });
afterEach(() => vi.restoreAllMocks());

test('a GitHub sign-in reaches the profile only through an email GitHub verified, and saves the username', async () => {
  github({ id: 4242, login: 'octo-person' }, [{ email: 'Person@example.test', verified: false, primary: true }, { email: 'other@example.test', verified: true, primary: false }]);
  const unverifiedAccount = await confirmGithubAccount('token');
  expect(unverifiedAccount.emails).toEqual(['other@example.test']);
  const other = await issueGithubSession(unverifiedAccount, now);
  await expect(personIdentityFromIdToken(other.token)).rejects.toMatchObject({ code: 'unauthorized' });
  github({ id: 4242, login: 'octo-person' }, [{ email: 'Person@example.test', verified: true, primary: true }]);
  const account = await confirmGithubAccount('token');
  const { token } = await issueGithubSession(account, now);
  await followGithubUsername(account);
  expect((await personIdentityFromIdToken(token)).person.id).toBe('person');
  expect((await profiles.doc('person').get()).data()?.githubUsername).toBe('octo-person');
});
