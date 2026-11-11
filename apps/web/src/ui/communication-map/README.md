# Communication map

`CommunicationMap` draws a project's agents as avatars and the direct messages between
them as straight lines without arrowheads. Agents that are talking to each other move
closer together. The Home tab shows the map inside the agent communication card
(`ProjectCommunication.tsx`).

## What the component does

The host passes in:

- the agents (`nodes`: id, name and owner);
- the message metadata (`traffic`: sender, recipients, audience and time);
- the moment to show (`at`), whether time is running (`running`), the replay speed
  (`speed`), whether this is a replay (`replay`) and whether the map should run
  (`active`);
- each agent's current state (`observations`);
- how to handle a crowded map (`crowding`, see [Crowded maps](#crowded-maps));
- callbacks for hovering an agent, selecting an agent and clicking a connection.

The map owns its camera and its layout worker. It does not fetch data, sign anyone in or control agents. The
host decides what selecting an agent or a connection does.

Only direct agent messages and recorded shared human steering make connections.
A person-to-agent message uses the same connection, moving dot, fading and motion
as an agent-to-agent message. Ownership alone never creates an edge. Messages to the whole project, updates and
questions never create connections.

## Controls

- One row holds anything the host passes as
  `toolbarStart` (on Updates: the people and agents strip and Copy project link), then **Zoom
  out**, **Fit map** and **Zoom in** at the right end. On Updates that row is in the agent
  communication card's header; elsewhere it is at the top of the map. The product map is
  2D; there is no 2D/3D switch (owner, 26 October 2026). The 3D engine is still reachable
  only through the `initialDimensions` prop, which no screen sets. Zoom goes from 0.5× to 12×. Avatars
  keep the same size on screen at every zoom; zooming changes the space between them.
- A project has one owner, so there is no owner menu or owner key (owner, 11 November
  2026). Every avatar has a ring in its owner's color; agents with no known owner get a
  gray ring. Hovering, clicking or keyboard-focusing an avatar highlights its owner's
  agents. Hovering or keyboard-focusing a person highlights that person and their agents
  in the same way, without showing an agent status tooltip. Clicking empty map space
  clears the highlight, selected agent and info box.
- Inspect an agent by hovering, clicking or keyboard-focusing its avatar. There is no
  Previous/Next control, agent switcher or automatic camera follow.
- A faint world grid sits behind the agents. Its lines stay at fixed world positions,
  so they move with the agents when you pan, zoom or orbit; the spacing gets finer or
  coarser as you zoom.
- Drag to pan. When the map has keyboard focus, the arrow keys pan, `+` or `=` zooms in,
  `-` zooms out and `Home` fits the map. In 3D, dragging and the arrow keys orbit the
  view instead; hold Shift to pan.
- Until you zoom or pan, the camera keeps every agent in view, except in a focused
  crowded view (see [Crowded maps](#crowded-maps)). **Fit map** returns to that view. Automatic overview expansion starts before
  portraits reach the edge and eases outward with a 700-ms time constant.
- Pressing a key or scrolling the mouse wheel outside the info box closes it.
  Modifier keys, and Enter or Space on an avatar, leave it open.
- Each connection is a button labelled "Show messages from A to B". On Home, it opens
  the thread of a recent direct message from A to B in **Agent conversations**, or
  the conversation list when none of the loaded messages matches.
- If the layout worker fails, the map shows "Map unavailable: (reason)." and a
  **Retry map** button.

## Crowded maps

Avatars keep a fixed 40px size, so many agents in a small pane overlap. The host picks
a `crowding` option; the default is `portraits`. Home uses `focus-active`.

- **When it counts as crowded.** The map checks, on a 44px grid, what share of avatars
  has a neighbour closer than 44px on screen. Above 10% the view is crowded; it stops
  being crowded below 3%, so it does not flip back and forth as agents drift.
- **Featured agents** always keep their portrait: agents in a visible connection, plus
  the inspected, selected and highlighted-owner agents. An agent stays featured for 4
  seconds of map time after its connection fades, so short exchanges do not flicker.
- **`portraits`**: every avatar keeps its portrait.
- **`shrink`**: other agents shrink with the space available, down to 40%.
- **`dots`**: when crowded, other agents become small dots in their owner's color
  (30% size; people 45%). A dot's hover target stays about 42px wide.
- **`focus-active`**: dots, and when the fit-everyone view is crowded, the camera fits
  the featured agents instead, easing toward them with a 2.5-second time constant in
  both directions. A paused map holds its camera still. A line at the bottom right says
  "+N agents outside view · Show all"; **Show all** fits every agent until **Fit map**
  or `Home` returns to the focused view.
- **`focus-ring`**: `focus-active`, with people placed on a ring outside their agents
  instead of moving freely (used by the lab only). The ring sits 120 world pixels
  beyond the farthest agent, or larger so people are at least 90 pixels apart, and
  grows or shrinks over about 3 seconds. Each person sits at the angle of their own
  agents' center, then neighbours are spread apart. People on the ring pull no agents,
  and avatars only avoid others of the same kind. In 3D the ring is flat.
- Sizes change over about 300 ms instead of snapping (at once with reduced motion).
- While crowded, people's names and "Person" labels show only on hover or focus.
- The map element reports `data-map-dense`, `data-map-focused` and `data-map-outside`
  for checks.

## How agents move

This section describes the 2-D map; [3-D mode](#3-d-mode) lists what changes in
3D.

- **Starting positions.** The worker places agents when the map first receives
  messages, using a PCA of the direct messages in the two minutes after the earliest
  direct message. When the host also passes later messages, as the lab does, this
  window can be ahead of the moment shown; connections and movement only use messages up
  to that moment. Agents with no messages in the window go on a spiral around
  the others. Without direct messages, agents sit on a spiral.
- **Connection strength.** Each direct message adds weight to its sender and
  recipient pair. The weight halves every 15 seconds of map time (the time being
  shown, so faster during a fast replay). A message stops counting after 45 seconds.
  A connection shows once its pair's weight reaches 0.015, and it gets fainter and
  thinner as the weight decays. Opacity and width ease toward their targets, so a
  connection fades in and out smoothly.
- **Movement has memory.** Opening-window PCA determines starting positions. Ongoing
  motion uses a shared damped spring simulation, rather than continuously optimizing
  t-SNE. The illustration prioritizes continuity over an exact embedding.
- **Relationships.** The two message directions combine into one physical
  relationship with strength `1 − exp(−weight)`. Strength eases in over a 1.2-second
  time constant and out over four seconds of visible wall time. Message expiry still
  removes the visible connection after 45 seconds; its physical influence fades
  instead of disappearing abruptly. Replaying faster changes traffic timing, not
  avatar speed.
- **Comfortable conversations.** Partners farther than 165 world pixels pull
  together; closer partners have no attraction. Message bursts and replies do not
  choose a new resting distance. Dense groups divide attraction by the square root
  of the larger weighted degree so many partners do not multiply their pull without
  limit. Forces between each pair are equal and opposite.
- **Gentle avoidance.** Avatars begin pushing apart inside 144 world pixels.
  Avoidance changes acceleration, never directly projects displayed positions.
  Exceptionally crowded scenes may compress this space; it is not a hard minimum.
- **Speed and settling.** Velocity persists across updates with exponential drag
  of 4 per second. Applied acceleration is capped at 90 world pixels/second² and
  speed at 32 world pixels/second. Physics substeps are at most 1/60 second. An
  avatar moving below 0.12 pixels/second with force below 0.5 for 0.8 seconds rests
  exactly; it wakes only when force reaches 2. This hysteresis suppresses tiny
  corrective movements. Interpolation uses a 120-ms time constant without a snap
  threshold or a second collision solver.
- **World edge.** Bounds are fixed from the seed, at least 460 world pixels from
  the center on each axis. Inside an 80-pixel edge band, a soft inward acceleration
  grows to at most 30 world pixels/second². There is no hard clipping.
- **Owners.** Agents outside conversations loosely gather toward the center of
  other agents of their known owner, within max(140, 55√N) world pixels in 2D.
  Owner acceleration is at most 2 world pixels/second². Conversation strength above
  0.08 disables owner pull. Unknown owners and single-agent owners have no grouping.

Apart from gentle avoidance, the owner pull and the world edge, idle agents keep
position. Pausing freezes displayed positions. A traffic refresh, including the
first messages arriving in an empty map, preserves existing positions and velocity.

## 3-D mode

**3D** gives every agent a third coordinate. Switching between **2D** and **3D**
places the agents again from new starting positions, fits the map and closes the
info box.

- **Layout.** The same damped motion engine, relationships, settling, avoidance and
  world edge work in all three dimensions. There is no separate ongoing solver.
- **Starting positions.** PCA uses three components from the same two-minute
  window. Inactive agents start on a 3-D grid with 140 world pixels between points.
- **Owners.** The comfortable owner radius is max(140, 70∛N) world pixels.
- **Camera.** The view has no perspective: far agents are not drawn smaller, and
  nearer avatars are drawn over farther ones. Orbiting re-centers the camera on all
  the agents. The map shows "3D · Drag to orbit. Shift-drag to pan." in its
  lower-left corner.

## Message passes

- Each direct message sends one dot along the connection to each
  recipient. The pass takes 1.4 seconds on
  screen.
- A message animates only once, even when a later refresh returns it again. In the
  live view, messages that were already there when the map first loaded do not
  animate. In a replay, going back in time, or changing the time while paused,
  starts the passes again from that moment.
- Dots only move while time is running.
- With reduced motion, connections still show, but no dots move and agents
  jump to their new positions instead of gliding.

## Layout worker

Each mounted map runs one module worker (`map.worker.ts`). The worker receives only
whether the map is in 2D or 3D, agent ids, owner ids and message metadata (sender,
recipients, audience and time). `metadataTraffic` in `protocol.ts` removes every other
field before a message is sent to the worker, so message text and names never reach it.

Each step request carries a sequence number, and the map ignores late replies.
While time is running, the map asks for a step about every 100 ms and draws at
most 30 frames a second. It neither steps nor draws while it is inactive or the
browser tab is hidden. The worker stops when the map unmounts. Each request includes elapsed visible wall
time, capped at 200 ms, so a slow or hidden tab never accumulates a catch-up run.

## How the Home card feeds the map

`ProjectCommunication.tsx` loads the map's data through routes that only project
members can read.

- **Agents.** `GET /communication/roster` returns 200 agents per page, each with its
  id, name, owner and creation time. The card loads every page, so there is no limit
  on how many agents the map shows. The roster reloads every minute. While it loads,
  the card shows "Loading agents · N loaded". If loading fails, it shows "Showing N
  loaded agents. (reason)" with a **Retry agents** button.
- **Agent states.** `GET /communication/agents/current` is the map's only status read
  (`current-state-source.ts`, contract C5-C7 in `research/platform-scale/current-state-contract.md`).
  The first read pages every agent of the project; each later read sends the last cursor
  and returns the agents that changed since. The map polls every 15 seconds, or every two
  seconds during Pause feedback. A refused cursor (400) starts a fresh first read, and a
  "not yet" answer (notReady) is asked again with the same cursor. Until a first read
  completes the map shows no states, never an empty complete one. A failed read (5xx,
  network) keeps what is shown, shows "Current agent states are unavailable.
  Communication history is still shown." and is retried next round. An access refusal
  (401/403/404) also clears the reader and the shown states. There is no other status
  read to fall back to. `data-status-rounds` on `.k42-communication-map-stage` counts each
  poll by what it rested on (`current`, `held`, `pending`, `error`).
- **Connections.** `GET /communication/traffic?at=(time)` reads the existing shared
  Conversations record (`conversationEntries`) and returns, 500 per page, the
  sender node, recipients, audience and time of shared messages in the five minutes ending
  at that time. It returns no message text. A page cursor only works for the same
  project, time and window. The card reads at most 20 pages (10,000 messages), drops
  duplicates, and rejects a frame whose time changed, a message outside the frame or
  a repeated cursor. The map only receives complete frames. If loading fails, the
  card shows "Recent connections unavailable: (reason)" with a **Retry connections**
  button. The card keeps the last complete frame.
  Steering uses `person:<profileId>` as its sender node. Bodies, names, mission IDs
  and receipt state are omitted. Earlier private instructions are not read. Clicking
  either kind of edge opens its newest message through the existing thread reader.
- **Refreshing.** The card's clock ticks every second. It refreshes every 5
  seconds. If the server answers a refresh with 429 (too many requests), the card
  waits for the Retry-After time, or 60 seconds when there is none, and shows
  "Updates will resume shortly." (plus "Showing the last loaded view." when a view is
  loaded) in a fixed-height line above the map, so the map does not move when the
  notice appears.
- **Closed projects.** Once the project is closed, no message dots move, and agents
  jump to their new positions instead of gliding.

## Files

- `CommunicationMap.tsx` and `map.css`: the component, its camera and its drawing.
- `grid.ts`: the world grid lines. `owner-colors.ts`: the color for each owner.
  `edge-appearance.ts`: the easing of connection opacity and width.
- `layout.ts`: connection weights and initial 2-D packing.
- `motion.ts`: persistent relationships, damped motion, avoidance, owners, bounds and
  the optional people ring.
- `pca.ts`: the PCA and the 2-D starting positions.
- `layout3d.ts`: 3-D starting positions and initial packing.
- `message-flights.ts`: message passes.
- `map.worker.ts` and `protocol.ts`: the layout worker and the messages it accepts.
- `projection.ts`: the 3-D orbit camera, screen positions and the **Fit map** view.
- `read-roster.ts` and `read-traffic.ts`: loading helpers for the Home card.

## Checks

- `npm run build:web` type-checks and builds the app.
- These tests cover the server routes and the Home card in a real
  browser. They run in a fresh disposable test session. Run the command from the
  repository root; the test paths are relative to `apps/server` (see
  [tests](../../../../../tests/README.md)):

```sh
node tests/run.mjs test/communication-replay.test.ts \
  test/communication-agent-status.test.ts test/communication-events.test.ts \
  ../../tests/integration/web-communication-agent-presence.test.tsx
```
