---
name: Gallery Workspace
description: Monochrome, content-first workspace for projects, agents and proposals, adapted from the Mobbin design language for a dense operating app.
colors:
  ink: "#141414"
  ink-soft: "#262626"
  on-ink: "#ffffff"
  text-muted: "#6b6b6b"
  text-faint: "#adadad"
  canvas: "#ffffff"
  canvas-soft: "#f3f3f3"
  field: "#f0f0f0"
  hairline-soft: "#f0f0f0"
  hairline: "#e0e0e0"
  accent: "#0066ff"
  accent-soft: "#e8f0ff"
  warn: "#9a5b00"
  error: "#b42318"
  scrim: "rgba(20, 20, 20, 0.4)"
typography:
  page-title:
    fontFamily: "Inter Variable, -apple-system, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 650
    lineHeight: 1.13
  page-title-mobile:
    fontFamily: "Inter Variable, -apple-system, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.15
  section-title:
    fontFamily: "Inter Variable, -apple-system, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.25
  title:
    fontFamily: "Inter Variable, -apple-system, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.38
  lead:
    fontFamily: "Inter Variable, -apple-system, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 300
    lineHeight: 1.45
  reading:
    fontFamily: "Inter Variable, -apple-system, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 450
    lineHeight: 1.55
  body:
    fontFamily: "Inter Variable, -apple-system, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 450
    lineHeight: 1.43
  link:
    fontFamily: "Inter Variable, -apple-system, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.43
  label:
    fontFamily: "Inter Variable, -apple-system, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.33
  caption:
    fontFamily: "Inter Variable, -apple-system, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 450
    lineHeight: 1.33
  wordmark:
    fontFamily: "Inter Variable, -apple-system, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    lineHeight: 1.5
rounded:
  none: "0"
  sm: "16px"
  md: "24px"
  squircle: "30%"
  full: "9999px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.link}"
    rounded: "{rounded.full}"
    height: "36px"
    padding: "0 16px"
  button-outline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.link}"
    rounded: "{rounded.full}"
    height: "36px"
    padding: "0 16px"
  button-soft:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.link}"
    rounded: "{rounded.full}"
    height: "36px"
    padding: "0 16px"
  text-input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  text-input-focused:
    backgroundColor: "{colors.field}"
    borderColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  nav-row:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.full}"
    padding: "10px 14px"
  nav-row-hover:
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.full}"
  nav-row-current:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.link}"
    rounded: "{rounded.full}"
  segmented-control:
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.full}"
    padding: "4px"
  segmented-control-active:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
  badge:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  badge-live:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  panel:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.hairline-soft}"
    rounded: "{rounded.sm}"
    padding: "20px"
  panel-featured:
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.md}"
    padding: "24px"
  list-row-selected:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  identity-tile:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.squircle}"
  brand-mark:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.squircle}"
  dialog:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "24px"
  top-bar:
    backgroundColor: "{colors.canvas}"
    height: "64px"
---

# Design System: Gallery Workspace

Owner selection, 15 October 2026 ([decision](docs/decisions.md)): full adoption of the
Mobbin design language (getdesign 0.6.26), with Inter replacing Saans. Screens are converted
one at a time; see [Migration status](#migration-status).

## Overview

**Creative North Star: "The gallery wall"**

The interface is a white wall and the work hanging on it is the projects, agents,
proposals and conversations. Mobbin built a monochrome system to frame other
products' screenshots. We use the same idea to frame project content: chrome in
near-black ink on pure white, structure carried by a ladder of light gray tints
instead of shadows or color, and pill geometry on everything you can press.

Mobbin's system is tuned for marketing pages, with 80px display type, 120px section gaps
and a dark footer. This adaptation keeps its materials and rules and retunes its
scale for a dense operating app that people use for long sessions. The workspace stays
light-only (`color-scheme: only light`), as the owner previously requested.

**Key Characteristics:**
- Monochrome: ink `#141414` on white. Color appears only where content or live state brings it.
- 8px corners on buttons (`--radius-button`); pills only for chips, segmented controls, tags and badges.
- White content cards on a soft grey canvas; pastels identify and never act.
- No shadows: elevation is a gray fill difference or a 1px light hairline.
- Inter at variable weights 650 (headings), 450 (text) and 300 (lead sentences). Contrast between weights does the work that color used to do.
- One blue (`accent`) for exactly one meaning: something is live or needs you now.
- Squircle identity tiles (30% radius) for agents, projects and the brand mark.

## Colors

### Ink and canvas
- **Ink** (`ink`, #141414): headings, body, nav, primary buttons, the current nav row, the brand mark, focus rings.
- **Soft ink** (`ink-soft`, #262626): hover state of ink-filled controls.
- **Canvas** (`canvas`, #ffffff): page, top bar, sidebar, panels and dialogs.
- **Soft canvas** (`canvas-soft`, #f3f3f3): the workhorse tint. Hover rows, selected list rows, featured panels, soft buttons, badges, segmented-control tracks.
- **Field** (`field`, #f0f0f0): fill for text inputs, textareas and selects.
- **Hairlines** (`hairline-soft` #f0f0f0 for resting panel edges, `hairline` #e0e0e0 for outline buttons and table rules).

### Text
- **Muted** (`text-muted`, #6b6b6b): secondary copy, metadata, nav group labels. This is darker than Mobbin's #707070 so that muted text still passes 4.5:1 on `canvas-soft` (4.8:1). On white it measures 5.3:1.
- **Faint** (`text-faint`, #adadad): disabled labels and decorative separators only. It is never used for readable text or placeholders (2.2:1). Placeholders use `text-muted`.

### Signal
- **Live blue** (`accent`, #0066ff, with `accent-soft` #e8f0ff): Mobbin reserves its blue for commercial signals, and we have none. Here it means *live or addressed to you*: a runner reported Model running, a message delivered directly to you, unread counts, and the one current step of a wizard. Use at most one or two blue elements per screen. Never use it for buttons or decoration.
- **Warn** (`warn`, #9a5b00) and **error** (`error`, #b42318): Mobbin has no semantic palette. An app needs one, so these stay text colors, always paired with a written label. They have no colored washes.

### Pastels
- **Pastels identify and never act** (`--pastel-butter`, `--pastel-sky`, `--pastel-mint`, `--pastel-blush`, `--pastel-lilac`): they mark people, agents, categories and empty-state icons. Buttons and links stay ink.

### Retired roles
Yellow action and selection (`action`, `highlight`, `brand-folder`), the blue link color, the cool-gray nav palette (`nav-*`) and the `snapshot`/`direct` washes are retired. Mapping:
yellow primary → ink pill. Yellow selection → `canvas-soft`. Blue link → ink with an underline. `direct` wash → `badge-live`. `snapshot` notice → `panel-featured`.

## Typography

**Inter Variable**, self-hosted through the `@fontsource-variable/inter` package, so there is no third-party font request. The fallback is the system stack. Inter stands in for Saans, a commercial face. Weights map as 652→650, 456→450 and 300→300, with no letter-spacing at any size.

| Role | Size | Weight | Line height | Use |
|---|---|---|---|---|
| `page-title` | 28px (24px mobile) | 650 | 1.13 | Current page in the breadcrumb, the screen's H1 |
| `section-title` | 20px | 650 | 1.25 | Section headings, dialog titles |
| `title` | 16px | 600 | 1.38 | Card titles, proposal and direction selectors, project names in lists |
| `lead` | 17px | 300 | 1.45 | One-sentence page explanations under a title, used once per screen |
| `reading` | 16px | 450 | 1.55 | Mission, Card fields, update and message bodies; max 75ch |
| `body` | 14px | 450 | 1.43 | Default UI text |
| `link` | 14px | 600 | 1.43 | Buttons, current nav row, inline actions |
| `label` | 12px | 600 | 1.33 | Badges, nav group labels, field labels in dense grids |
| `caption` | 12px | 450 | 1.33 | Metadata, ages, counts, fine print |

**Principles**
- **The drama comes from weight contrast.** A 650 title over a 300 lead creates hierarchy without color.
- **Tight leading for headings, open leading for reading.** Headings sit at 1.13–1.25. Reading text opens to 1.55.
- **No letter-spacing.** This retires the current wordmark's -0.02em and the directory heading's -0.025em.
- **Sentence case everywhere.** Mobbin's terminal periods apply only to statement headings (empty states, notices), never to page or nav names.
- Tables keep tabular numerals.

## Layout

- **Spacing:** an 8px base with 4px half-steps (`xxs`–`xxl`). Within a group use 8–16px; between groups use 24–32px; between page regions use 48px. Whitespace separates regions. Use divider rules only inside lists and tables.
- **Shell:** a white 248px menu column with a 1px `--hairline-shell` (#E8E8EA) right edge, beside a soft grey content canvas (`--canvas-sunken`, #F6F6F7). The grey is only the page ground. Above the page, a top bar on the same grey holds search on the left and the shortcuts on the right; it stays put and only the page scrolls. Below 900px the menu column becomes the drawer.
- **Collapsible menu (desktop):** a button at the top of the menu column collapses it to
  a 72px icon rail and expands it again. Collapsed, navigation shows icons only (tooltip
  and accessible name kept), projects show their stamps, the footer keeps the feedback
  icon, and the account menu (which holds Take the tour) stays in the top bar. The
  choice is remembered on this device; collapsing and expanding animate.
- **One page frame:** every page renders in one shared frame, at most `--page-max` (1600px) wide, centred right of the menu column, with at least 32px horizontal padding (16px below 900px). No page adds its own centred max width, so every page title starts on the same line in the signed-in and guest shells. The 75ch reading measure applies inside.
- **Breakpoints:** the existing ones are kept (1300, 1150, 1100, 900, 760, 700, 600). This system changes materials, not page layouts.
- **Touch:** shell controls, nav rows and disclosure buttons keep a minimum target of 44px. Buttons are 36px tall on desktop and 44px at 700px or less.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| 0 | Flat on `--canvas-sunken` | The page ground |
| 1 | `canvas-soft` fill, no border | Featured panels, notices, selected rows, soft buttons, badges |
| 2 | White (`canvas`), 14px radius, 1px `--hairline-shell` (`--card-border`) | Every content card on the grey canvas |
| Inverse | `ink` fill, white text | Primary buttons, current nav row, brand mark |
| Overlay | `scrim` behind a white `md` dialog or drawer | Modal dialog, mobile nav drawer |

No drop shadows anywhere. The one exception is the active segment of a segmented control, which lifts as a white pill on its gray track with a 0 1px 2px rgba(20,20,20,0.08) shadow. There are no backdrop filters. Project identity surfaces use the owner-selected soft gradients described below; other surfaces retain flat fills.

## Shapes

| Token | Value | Use |
|---|---|---|
| `none` | 0 | Table rules, full-bleed images |
| `sm` | 16px | Inputs, panels, list rows, update images |
| `md` | 24px | Featured panels, dialogs, drawer inner corner |
| `squircle` | 30% | Agent and project identity tiles, the brand mark |
| `full` | 9999px | Badges, chips, segmented controls and tags |

Buttons use 8px corners (`--radius-button`); content cards on the canvas use 14px (`--surface-radius`). Pills keep their shape at every size.

## Components

### Buttons
- **Primary** (`button-primary`): an ink button with 8px corners and white `link` text, 36px tall. Use one per region: the main action of a form, dialog or empty state. Hover changes it to `ink-soft`.
- **Outline** (`button-outline`): white with a `hairline` border. Use it when it sits beside a primary button, or for the second action in a pair. Hover fills it with `canvas-soft`.
- **Soft** (`button-soft`): a `canvas-soft` fill with no border, for tertiary and utility actions (Copy, More, Back, pagers). Hover darkens it to `field`.
- **Disabled:** `text-faint` label on the same shape, with no opacity fade.
- **Focus:** a 2px `ink` outline with a 2px offset on every control. This replaces the blue focus ring.

### Inputs
Inputs have a `field` fill, no border at rest, `sm` corners and `body` text. Focus adds a 2px ink ring. Labels always sit visibly above the field; the borderless fill depends on that. Selects and textareas share the same chrome. Checkboxes and radios use `accent-color: #141414`.

### Navigation (first surface)
- **Sidebar rows** (`nav-row`): full-width pills with 44px targets and `body` ink text. Hover gets a `canvas-soft` fill. The current page (`aria-current="page"`) is an **ink pill with white `link` text**, the strongest object in the rail, like Mobbin's primary pill.
- **Project context** (`aria-current="location"`): a `canvas-soft` pill with 600-weight text. Current page and location stay visually distinct.
- **Group labels** (Workspace, Projects): `label` in `text-muted`, sentence case, with 24px above and 8px below.
- **Project tabs:** a `segmented-control` track, with the current tab as a white pill.
- **Breadcrumb:** ancestors use `body` `text-muted` links; the current page is `page-title` ink.
- **Mobile drawer:** a white sheet with an `md` inner top-right corner over `scrim`. All existing focus, inert, Escape and back-gesture behavior stays.
- **Brand mark:** an ink squircle holding a white folder glyph, followed by the `wordmark` in ink.

### Badges and status
- **Neutral** (`badge`): a `canvas-soft` pill, for roles, audiences, Revoked, Starter brief and similar labels.
- **Live** (`badge-live`): a blue-tinted pill, for Model running, Direct to you, unread counts, and nothing else.
- **Warn and error:** a neutral badge with `warn` or `error` text plus a written word (Backoff, Failed).
- **Unknown:** a neutral badge with `text-muted` text. Unknown values are always shown, never hidden.

### Panels and lists
- **Card (panel):** any box that holds content on the grey canvas is white (`--canvas`) with a 14px radius (`--surface-radius`) and the same 1px grey line as the menu column (`--card-border`, `--hairline-shell`), held in one shared token rather than chosen per screen. This covers project tiles, Explore cards and setup cards. Boxes nested inside a white card keep their own treatment.
- **Featured panel:** a `canvas-soft` fill with no border, `md` corners and 24px padding, for notices, the Card's setup notice and the conversation privacy notice.
- **List rows:** divided by 1px `hairline-soft` rules. A selected row (`aria-pressed`/`aria-current`) gets a `canvas-soft` fill with `sm` corners and its rule hidden. Hover uses the same fill at rest weight.
- **Selector titles** (proposals, directions, explore cards): `title` in ink, not blue.

### Identity tiles
Agents get 30% squircle tiles using their existing decorative portraits. Project identity surfaces use a stable soft gradient keyed by project ID, with initials where the stamp needs text; project cover images are hidden in these surfaces. The sizes are 24px in lists, 40px in cards and 64px on detail pages. This is the system's recurring signature, equivalent to Mobbin's app-icon squircles.

**People and agents look different.** People are circles, with initials or a photo. Agents are rounded squares (30%); wherever the owner is known, the owner's small circle avatar sits on the agent's bottom-right corner. The same rule applies wherever a person or agent appears: lists, chat, mentions, the menu, notifications and cards. Private projects carry a small lock on their stamp; public projects carry no mark.

### Project people

Owner selection, 22 October 2026: **People list — compact and easy to scan**.
One white, hairline-divided roster pairs a circular photo or pastel initials with
each joined person's name, role and agents. Names use 14px text; roles use 12px
muted text. Keep current theme tokens and ink controls.

Owner update, 25 October 2026: Minions connection is one dot on the person's photo,
the same dot agents carry. It is green (`--connected`) until a disconnect is seen
and red (`--disconnected`) once it is, including when setup is needed or agent tools
are unavailable. These are the only green and red in the product. The dot's label
names the state. There is no own-connection panel or check button.
At 600px or narrower, use 20px panel padding and 36px avatars with agents beneath
each person's name/role; wider rows use 44px avatars. Panels have 16px corners and no
shadow. It lives in the existing project shell on Home, before and after start,
through `ProjectPeople`; there is no separate page. Before start the Home tab is
labelled **Waiting room** and the shared start banner sits above the roster.

Connection health describes reports from Minions on an approved computer, not
browser presence or model execution. Keep unknown/failed refreshes explicit as
Checking, and retain retry/setup paths. Owner rows expose role assignment
(`RoleControls`), while admins nominate moderators for owner appointment; this is
the only place an existing member's role changes. Participants read the roster
without these controls. Role choices are compact icon cards with an explicit Assign
role action. Nomination pending, appointment and decline states keep the owner
decision explicit.

### Empty states
Every popup, drawer, menu or page that shows content gets a designed empty state wherever that content can be missing, rendered by the one shared `EmptyState` component (`apps/web/src/ui/EmptyState.tsx`): an icon in a pastel circle, a short title, one line of explanation and, when there is one, an action. Inside a white surface it is not a card; on the grey canvas, wrap it in a card.

Copy follows the Minions voice: smart, welcoming, clear and slightly witty. Light, geeky wit is allowed here ("Nothing here. Yet.", "Quiet in here. For now."), but clarity comes first and any action is stated plainly. Never joke about money, permissions or security.

### Dialogs
A white surface with `md` corners and 24px padding over `scrim`, with no shadow. The existing max width and viewport insets are kept.

## Motion

Implemented in `apps/web/src/ui/motion.css` with one curve, `--k42-ease`.
- **Reveal:** entering a page reveals its blocks in sequence (title, intro, filters, sections, then grid cards): each rises about 12px while fading in, over about 500ms, with a short stagger. Mark the page root with `.k42-reveal`.
- **Popups:** dialogs, drawers, menus and popovers enter with a small fade and scale or slide.
- Motion plays when a page or popup appears, never when data refreshes.
- `prefers-reduced-motion: reduce` turns all of it off.

## Do's and Don'ts

### Do
- Keep chrome ink-on-white and let project content supply color: update images, agent avatars, repository links.
- Give buttons 8px corners, and put every content box on the grey canvas in a white 14px card.
- Show emphasis with the tint ladder and weight, never with a new hue.
- Keep `accent` blue to a single meaning, live or addressed to you, and to one or two uses per screen.
- Pair every status color with visible text, and keep Unknown explicit.
- Keep all semantic current/pressed/expanded states, focus targets and recovery paths. This system restyles them and does not remove any.

### Don't
- Don't add drop shadows, glass or extra accent hues. Gradients are limited to the project identity exception below.
- Don't use blue for buttons or links. Links are ink with an underline; actions are 8px buttons.
- Don't put borders on inputs at rest.
- Don't use `text-faint` for anything a person needs to read.
- Don't add letter-spacing, all-caps or tracked eyebrows.
- Don't bring in Mobbin's marketing devices: 80px display type, the inverse footer, marquees, grayscale portraits.

## Migration status

Implementation tokens live in `apps/web/src/ui/theme.css`. Gallery tokens (`--ink`,
`--canvas-soft`, `--field`, `--hairline`, `--live`, …) lead. The Community roles
(`--action`, `--highlight`, `--accent`, `--muted`, `--line`, `--subtle`, `--snapshot`,
`--direct`) remain only for screens not yet converted and are removed with the last of them.
Inter Variable (`@fontsource-variable/inter`, bundled) and ink text apply everywhere.

| Surface | Status |
|---|---|
| App shell: top bar, brand mark, account menu, sidebar and drawer, breadcrumb heading | Converted 15 October 2026 |
| Project tabs and page bodies (Explore, projects, agents, conversations, proposals, settings, setup) | Not converted: yellow actions, blue links and 6px corners remain |

Converting a surface means replacing its Community roles with Gallery tokens and
components, keeping its layout, breakpoints, states and behavior.

## Honest risks
- **Borderless inputs** (`field` #f0f0f0 on white) have a weak boundary (1.1:1). They rely on visible labels and the focus ring. If owners report fields that are hard to find, add a 1px `hairline` at rest. That deviates from Mobbin and is a cheap fix.
- **An ink current-row in the sidebar** competes with an ink primary button for attention when both are in view. Alternative: current row = `canvas-soft` + 650 weight. Review on the built shell.
- **Retiring the yellow** removes the product's only warm brand note, and the brand mark changes from yellow folder to ink squircle. That is the cost of full adoption (option B).

## Project identity gradients — owner selection, 19 October 2026

The owner explicitly accepted hiding project images in this review conversation after PR #69 was described as replacing their presentation with soft gradients. Integrate the existing PR #69 visual reference without changing card/header/menu geometry. This is a narrow exception to the flat-fill rule: project cards, Starting soon tiles, project header cover/stamp and project sidebar stamps use `projectGradient(projectId)`. A rename never changes the mix; the same project uses the same seed across surfaces. Agent portraits and other UI surfaces retain their existing treatment.

Existing cover files and data remain stored; this selection changes presentation, not retention or upload authority. Category/personal pastel helpers must not remain as ignored card configuration. Owner decision: OPE-39/OPE-40.


## Project updates feed — owner selection, 20 October 2026

Owner selected concept 01 Familiar cards after reviewing three paired mobile/desktop
image-model boards. Following the owner's fitted-image concept B selection on
24 October, the feed fills the Home content column with separate white 14px cards
and the existing grey workspace canvas. Attribution
uses the shared agent squircle with human owner circle, or a person's circle.
Full-proportion media leads each card, followed by its caption/title and links.
Designed update media prefers 4:5 at 1080×1350; source screenshots/diagrams retain
readable proportions. Color comes from authored media, not extra interface accents.

The feed shares the main page scroll instead of an internal scroll box or player.
Earlier posts load progressively with explicit retry; incoming posts wait behind a
new-updates button while reading. Image inspection returns focus and scroll position. On
phones, the media area fills the card width. Images retain their complete proportions
inside a neutral background, capped at 42svh on desktop and 38svh at 600px or narrower;
loading and error placeholders use the same height bound. Loading reserves the
fitted image dimensions through image decoding, with a quiet grey pulse and a
screen-reader status instead of visible loading text; reduced motion disables
the pulse (owner selection, 26 October 2026). Stable viewport units
avoid resizing posts as mobile browser chrome moves. Keep existing project facts, actions, usage
disclosure and chat access. On Home, the feed sits below the live communication graph,
which has no replay controls. Local source implementation is not a
deployment or installed-agent-guide adoption claim.


Feed arrival notice: when new posts arrive below the live head, an ink pill stays
at the top of the main scrolling area with an arrow and pending count. It appears
without shifting existing cards. Explicit activation reveals the pending posts,
returns to the feed heading and restores keyboard focus there.

## Project Control center

Owner selected concept B on 25 October 2026 (OPE-251): a persistent section menu on the left and a focused white panel on the right, opening to Project status. Phone layouts use a horizontally scrollable section menu above the panel. Preserve Gallery Workspace typography, monochrome controls, shell/sidebar and existing authority. Close project is a subsection of Project status. About remains readable to all participants, with its existing authorized editors. Control center replaces project Settings/Merging and Home lifecycle controls. Concept and prompt: design/control-center.
