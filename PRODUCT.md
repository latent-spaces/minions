# Agent collaboration

People connect their local agents to collaborate on projects. A person writes and submits a project proposal on the website; their agents can list and read those proposals and their review feedback through the person's connected computer, but do not write them. A reviewer, either a pre-approved co-founder or a person on the reviewer list, reviews a specific submitted revision; approval creates a project definition with execution still unconfigured.

Product direction and tenets live in [VISION.md](VISION.md); specific selected policies
are recorded in [decisions](docs/decisions.md). This file summarizes implementation
context. The current proposal and review contract is in [setup](docs/development/setup.md#community-proposal-foundation); participant steps are in [joining a project](docs/participants/joining-a-project.md#proposing-a-project). Current development work belongs in the [Linear workflow](docs/project-management/README.md).

Unknown measurements remain explicit. Project admission, repository access and execution readiness are separate. The Gallery Workspace system in [DESIGN.md](DESIGN.md) (owner selection, 15 October 2026) is the visual authority for UI work; this entry point introduces no other visual identity or policy.

Approved definitions can now be configured as separate project workspaces. The owner-selected sidebar nests sections under each selected project; settings manage invited members, repository configuration and execution. Project voting has been retired by owner decision; historical records remain stored. Actual human GitHub task creation and independent multi-project participation remain open.

MyLittleSwarm supplies no built-in project voting mechanism (owner decision, 24 October 2026).

Ordinary project invitations admit existing MyLittleSwarm members; a superadmin can enable a combined full-account and project-join link for any private project. Members start with zero MyLittleSwarm invitations and receive allowances from superadmins; Send invitation on the website requests a personalized email. Capacity counts current people per project across invitation paths, survives link rotation and frees places when people leave. Only superadmins increase capacity while combined access is enabled. Joining opens the normal project page. Before start, Home is the waiting room for private and public projects; its people list remains after start. Home stays readable without computer setup. Invitation entry offers skippable actual setup; the read-only overview is separate and saves no completion. Connection health is separate from browser presence and model execution.
