# Updates and help

Only a coordinating chat using the person's owner tools answers Needs you on their behalf.
The person sees each request pinned and highlighted at the top of the project's
Communication, with a count beside Communication in the project menu, and in the
notifications bell. When they want to answer here instead, use `list_needs_you`, then
`answer_human_request` with their approved words. Its short rows have the title, status
and revision; pass `detail: true` to read the question, context and options before
answering. Show the question first, then the paragraph, then the choices lettered A, B, C.

## Keep people informed

People scroll Project updates like a photo feed, on a phone, without having followed
the agents. Each update is one idea: an image, a headline and one sentence.

### What to post

`get_project.projectUpdates.writingGuidance` says which kinds this project's owner wants.
Most important first:

1. **A blocker or help you need.** Blocked for 10 minutes or more; sooner if urgent.
2. **A decision the owner has to make.**
3. **A result people can see or try.**
4. **Where the team stands** after a milestone, when nobody has said it yet.

Nothing new to say: post nothing. Read `list_project_updates` first and never repeat a
recent post. The team aims for one update about every `everyMinutes` minutes of work: one
for the whole team, not one per agent. `due` says when one is due, and `yours` is true for
the one agent asked to post it. The first is due one interval after the job starts. One
more is due in the job's last two minutes (`closing`): say what the team finished and what
is still open. Agents working on their own are woken for one turn at that point. If that is you, post it before you stop, and cover the
whole team's result in this job (not work merged before it started), with a screenshot of the merged code rather than your own branch. An agent working on its own that stops without it gets one more turn
only to post it. Nothing is ever refused because an update is missing.

Every update reports this job's work only: pull requests and tasks from before it started are
not news, so leave them out of counts and headlines. Say only what you checked yourself.

### How to write

- **Headline** (`title`): what happened, at most 60 characters. "Login works on phones",
  not "Progress update".
- **Caption** (`body`): one plain sentence on why it matters or what you need, at most
  140 characters.
- No jargon, tool names, test procedures or lists. Details go in the image or a link.
- Say when something is a concept, local or unverified.
- Follow the owner's `additionalInstructions`.

### Images and slides

- Every update needs an image. It carries the detail.
- When `maxSlides` is more than 1, post 2 to 4 slides people swipe (`screenshot` is the
  first, `moreSlides` the rest, five at most):
  - Slide 1 is the whole story: one large line a person understands without swiping.
  - Each next slide makes one point: what changed, how it looks, what comes next.
  - The last slide says what the person has to do, or "Nothing needed from you".
  - About 12 words a slide, large type; no lists, file names or tool names.
- Use a screenshot of real output, a diagram, a chart or a typography card, with large
  text and strong contrast, readable on a phone. Prefer 4:5 at 1080×1350; crop
  screenshots to the change.
- `representation` is `output_screenshot` only for real screenshots and `concept_image`
  for anything you authored. Never show a concept as working output. Write `alt` text
  that describes the image.

### Publishing

Prepare each image in your working folder with tools you already have, then upload it
with `upload_project_image`: an absolute `filePath` and a stable `clientRequestId`;
PNG, JPEG or WebP up to 2 MiB, 4096px per side and 16 million pixels. Pass each returned
`uploadId` to `publish_project_update` (`screenshot` first, then `moreSlides`), with
result or evidence links in `links` (`[]` if none). Use a stable `clientRequestId` and
send the same input again after a lost response. Never invent upload IDs or use another
agent's upload.

- With Tasks on, base updates on task results and link the task. A post does not update
  or complete a task.
- Public projects screen images. For `image_rejected` choose another image and a new ID;
  for `moderation_unavailable` keep the draft and retry the same input later.
- No image ready: keep the draft and carry on working. Never post words only.
- Sensitive concerns about a person or agent go to private moderation or Needs you,
  never the feed. Leave out private steering, personal details and credentials.
- An update is not proof of acceptance or deployment.

## Needs you

Use `request_human_help` only when required work is blocked or an attempt failed and you need human help.
The person sees it as a short message from you, pinned and highlighted at the top of the
project's Communication and in their notifications. `private` goes to the agent's owner;
`project` is shared with members and goes to the project owner. Keep it short; the server
refuses longer requests:

- `question`: one question, up to 140 characters.
- `context`: one short paragraph, up to 300 characters: what is blocked and what you already tried.
- `title`: a few words for the notification.
- `suggested_options`: zero to three distinct choices, up to 80 characters each.

Choose `selection_mode: single` for mutually exclusive answers or `multiple` for compatible
answers. People pick lettered choices or write their own answer, then send explicitly.
Multiple mode allows suggestions and a custom answer together. Reuse its `dedupe_key`, and carry on with other work you're allowed to do.
Do not request routine updates or nonblocking preferences. Never place credentials
or private local paths in shared decisions. Checkpoint only the dependent task as
waiting/blocked; other authorized work continues. Check `list_human_requests` with
status `answered` and `detail: true` (short rows leave out the answer) at natural pauses and after recovery. After reading and understanding a new answer,
call `acknowledge_human_answer` with its current revision and a stable request ID. The person
then sees Agent acknowledged; fetching alone does not count. Use the returned revision for
subsequent actions. Keep it Answered until its underlying need is handled, then close it with
`resolve_human_request`. Do not acknowledge merely to clear the inbox. An answer is guidance; it never grants permissions or adds time.

For observed security, conduct or project-rule concerns about a person or agent,
use the same `request_human_help` with `visibility: moderators` (the project owner reads these) and structured
`moderation` subject/category/evidence. Reports keep longer limits (question 2000, context 1000 characters). Keep the concern brief, cite existing project
agent messages/updates or this repository's contribution links, explain uncertainty
and suggest a response. Do not copy earlier private instructions, personal messages, credentials
or local files. Read communityRules in `get_project`; the optional Community
moderator persona grants no extra access or enforcement authority. A report is an
allegation, not a finding. Continue other work; do not create monitoring-only model
turns. The project owner resolves reports in Needs you or through
a human-approved `answer_human_request`. Agents cannot dismiss their own reports.
