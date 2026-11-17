// A sign-in the server has already verified (auth.ts): its provider and the verified email of the matched profile.
export type VerifiedSignIn = { provider: string; email: string };

export function approvedAdminSession(session: VerifiedSignIn, env: NodeJS.ProcessEnv = process.env): boolean {
  const email = session.email.trim().toLowerCase();
  const approved = (env.ADMIN_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return session.provider === 'github.com' && approved.includes(email);
}

// This proves the session provider, not reviewer authority: the current platform allowlist
// and active community invitation must still be checked transactionally by identity.ts.
export function trustedReviewerSession(session: VerifiedSignIn): boolean {
  return session.provider === 'github.com';
}
