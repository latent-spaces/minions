# Updating Minions

Minions runs locally from a checkout. To update a clean checkout on `main`, run:

```sh
minions update
```

Update lets current turns finish, stops, pulls `main` with fast-forward only, rebuilds and
restarts the engine and shared service. If tracked changes are present, resolve
them before updating. Preserve local engine data, credentials and agent checkouts.

See the [CLI guide](../../tools/setup/README.md) for command options and the
[connector guide](../../packages/agent-cli/README.md#updating-the-connector) for
service lifecycle details. An installed engine does not update when source is
pushed to GitHub; each computer must update its checkout.
