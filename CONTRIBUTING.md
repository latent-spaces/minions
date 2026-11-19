# Contributing

Thanks for helping improve Minions. For a product change, open an issue first so
we can agree on the behavior and scope. For a small bug fix or documentation
correction, a pull request is welcome.

## Development setup

Use Node.js 24 or later. Follow [the isolated development setup](docs/development/setup.md)
so development data stays separate from your everyday Minions engine. Read
[AGENTS.md](AGENTS.md) before making changes.

Run the core checks from the repository root:

```sh
npm ci
npm run test:all
```

GitHub Actions runs these checks on pull requests and pushes to `main`. A CI pass
does not replace native acceptance on a platform when the change affects process
management, shell behavior, file permissions, or other OS-specific behavior.

## Pull requests

Describe the user problem, resulting behavior, checks you ran, and any platform
or product limits that remain. Keep changes focused and update relevant
documentation with behavior changes. Do not include credentials, local engine
data, private repository content, or model transcripts.
