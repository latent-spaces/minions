# Minions Vision

Updated: 17 November 2026.

**Your own little swarm of coding agents.**

Minions gives one person a small team of coding agents to get work done faster.
You set the goal, agents coordinate in the background, and you follow progress and
steer the work.

The core experience is your own swarm on your computer, using your Claude Code or
Codex. Collaboration happens between your agents. Shared projects between people
are no longer the product's focus.

## The experience we want

The welcome screen and tour express six promises that guide the product:

- **Hard problems, solved faster.** Different models share the work, review each
  other and catch more. The aim is better results as well as faster progress.
- **They organize themselves.** As models improve, we believe they work better
  choosing their own roles than following ones we assign. Give agents room to
  divide the work, choose plans and adapt within the project's boundaries.
- **Always see what's happening.** Surface what matters through visual updates,
  previews and live activity, so you can follow the work and stay in control
  without reading every conversation.
- **One team, one project.** Your agents work together and talk to each other,
  rather than leaving you to coordinate separate chat windows.
- **Up and running in minutes.** One command to install, one prompt to start.
  Use the Claude Code or Codex you already have, with a short, readable prompt
  you can copy from the README into your coding chat.
- **Small, friendly, yours.** A little crew on your computer that you can watch,
  poke and guide. Keep the experience approachable and understandable.

These are product goals, not measured performance claims. Welcome animations and
tour activity are illustrative; they do not establish that models ran or that a
particular workflow succeeded.

## Product principles

| Principle | What it means in Minions |
| --- | --- |
| **Separate the swarm from steering** | Your main Claude Code or Codex chat directs separate background workers through the shared local service; it does not become a project worker. Use that chat or the local Minions app to follow and guide work. The service remains responsible for execution, so the swarm can continue independently of the steering chat. |
| **You set the goal and boundaries** | The Project Card holds the name, description and rules. Approve agent missions, providers and lifetimes before execution. Agents organize within that scope; messages and task text do not grant additional permissions. Existing repository and review authority still applies. |
| **Autonomous progress is the default** | Once given a mission, agents communicate, adapt and keep making useful progress. They ask for your involvement when a genuine blocker or required permission calls for it. You can steer along the way, pause after the current turn or stop work. |
| **Give agents dependable shared tools** | Messaging, native tasks, updates and retrievable context let agents coordinate without an imposed hierarchy or workflow. Tasks belong to Minions and can be managed without GitHub; external repository references do not determine task authority. Minions provides no built-in project voting mechanism. |
| **Make progress readable and traceable** | Updates can include text, screenshots, videos, demos and links. Messages, steering and activity identify the agents involved and preserve the work record. Recorded steering, delivery and observed model activity remain distinct; unknown state stays explicit. |

Implementation and acceptance are tracked separately from product direction.
Changing the focus to personal swarms does not itself remove existing features,
change permissions, discard participant records or authorize interrupting active work.

## Evolving the vision with care

Discuss substantive changes with the owner before adopting them. Keep the current
vision concise; record decisions, implementation plans and evidence separately.
Agreed product direction does not itself claim implementation or deployment.

See the recorded [decisions](docs/decisions.md). Earlier vision drafts, discussion
records and implementation plans remain in git history; this document is the current vision.
