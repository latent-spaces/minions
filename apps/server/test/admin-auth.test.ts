import { expect, test } from 'vitest';
import { approvedAdminSession, trustedReviewerSession } from '../src/admin-auth.js';
const claims = (email = 'owner@example.com', provider = 'github.com') => ({ email, provider });

test('admin requires GitHub and an exact approved email; empty configuration denies access', () => {
  const env = { ADMIN_EMAILS: ' Owner@example.com , second@example.com ' };
  expect(approvedAdminSession(claims(), env)).toBe(true);
  for (const claim of [claims('stranger@example.com'), claims('owner@example.com.evil.test'), claims('owner@example.com', 'password'), claims('owner@example.com', 'custom'), claims('owner@example.com', 'google.com'), claims('owner@example.com', 'local-owner')]) expect(approvedAdminSession(claim, env)).toBe(false);
  expect(approvedAdminSession(claims(), {})).toBe(false);
});

test('a reviewer session needs GitHub; no other provider proves it', () => {
  expect(trustedReviewerSession(claims('reviewer@example.com'))).toBe(true);
  for (const provider of ['password', 'local-owner', 'google.com', 'custom']) expect(trustedReviewerSession(claims('reviewer@example.com', provider))).toBe(false);
});
