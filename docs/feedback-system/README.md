# Private feedback system

The website no longer asks for feedback: there is no feedback button, and no prompt after
pausing or closing a project (owner, 11 November 2026). The private report inbox below
stays on the server, with any reports already sent. Only the author and existing verified
platform admins can read a report's text or screenshot. This is feedback about
MyLittleSwarm itself. It is separate from the feedback reviewers give on proposals.

## Admin inbox

Open **Super admin → Feedback**. New, Reviewing and Resolved queues show up to 20
reports per page; the list buttons do not show how many reports each list holds. Select
a report to read it and explicitly load its screenshot. Each status change sends the
report's current revision number and a request ID; a retry resends both unchanged. If
another admin changed the report first, your change is refused as a conflict instead of
overwriting theirs. Retrying the latest successful status change returns the same
result; an older one is refused, so check the current report and choose again. A status
change that is not yet confirmed is kept across a page reload, and only the same admin
profile can retry it.

Project ownership or reviewer status does not grant access. Other participants cannot
read a report even if they share its author's project. Opening a screenshot directly
also requires permission. The response tells browsers and caches not to keep a copy
(`Cache-Control: private, no-store`) and not to guess the file type
(`X-Content-Type-Options: nosniff`). User text is rendered as text, not HTML.

## Data and limits

Reports are stored in the Firestore collection `feedbackReports`. Screenshots are stored
as private documents in `feedbackScreenshots`, and each author's hourly report count is
kept in `feedbackBudgets`. No new bucket or storage credential is required. The durable
limit is ten new reports per account per hour; retrying the same send does not use up
another slot. Each API server also keeps an in-memory limit of 30 feedback requests per
person per minute, to stop bursts. These are beta limits, not a guarantee of unlimited
capacity.

A person's own data export includes their reports, their re-encoded screenshots and
their hourly report count. It leaves out which admin last changed each report's status.
When an account is removed, the existing account cleanup deletes its reports,
screenshots and hourly report count, 20 reports at a time. Normal feedback is retained
until that cleanup or an operator handles a data-removal request; there is no new
automatic time-based retention policy or public publication. No real participant data is
deleted by development tests.

## Development and release

Tracked in
[OPE-245](https://linear.app/openkarma/issue/OPE-245/feedback-add-private-beta-reports-and-an-admin-inbox),
under OPE-40.

From a checkout with dependencies installed:

```sh
npm run build:contracts
npm run typecheck:backend
npm run build:web
node --import tsx --test apps/web/test/*.test.ts
node tests/run.mjs test/private-feedback.test.ts test/review-regressions.test.ts test/account-onboarding.test.ts ../../tests/integration/web-feedback.test.ts
```

The last command starts its own throwaway test session, with its own SQLite store and
local sign-in, and uses made-up accounts. It runs the real app and checks
a normal and an admin session, recovery after a lost server reply, private screenshot
viewing, that HTML typed into a report shows as plain text, and the layout at 1440px and
390px wide. `MLSWARM_TEST_BROWSER_EXECUTABLE` can select installed Chromium. It sends no
real email, runs no AI model, and neither imports nor resets the engine's data.

The inbox query reads `feedbackReports` by status, then createdAt newest first. Account
cleanup runs through its existing signed-in API route. This repository no longer deploys to a live site.