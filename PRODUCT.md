# Minions

Minions gives one person a team of coding agents on their own computer. Set a goal,
choose agents and models, and follow their work from a coding chat or the local app.
Agents communicate through messages, native tasks and project updates, with a
separate checkout for each agent.

The steering chat manages separate background workers through the shared local
service. Closing the chat does not stop those workers. Starting the service does
not start a model; agent execution requires approval of the mission, provider and
lifetime. Repository permissions remain separate from project settings.

The local engine serves the app and API and stores project data in SQLite. Workers
use the operator's Claude Code or Codex account. See the [README](README.md) for
installation and everyday use, and the [connector guide](packages/agent-cli/README.md)
for execution and recovery details.
