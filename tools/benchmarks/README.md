# Explicit local studies

After root `npm ci`, run a selected study with `npm run benchmark -- STUDY ...`.
The launcher supports `context-footprint`; it runs the study in a disposable test
session with its own SQLite store and media folder. Studies never run during local
startup or default tests. Model execution and cloud targets are not enabled by this
launcher.

Provide report destinations explicitly. File arguments resolve against the invoking
directory. Source and inputs are anchored to their actual repository owners rather
than the launcher's temporary working directory.

The offline calculators and their tests (`npm --prefix
tools/benchmarks test`); they read no database.

## CooperBench patch scoring

`cooperbench.py` uses the upstream Docker evaluator to score a pair of Git
patches from the same benchmark base commit. It writes a fresh run directory
with the inputs, merge status, and test results for both features. The runner
only scores existing patches and does not start Minions, Paperclip, or a model.

Install Docker and `uv`, then check out the pinned evaluator and dataset outside
the Minions worktree. The runner uses the upstream lockfile with Python 3.12.

```sh
git clone https://github.com/cooperbench/CooperBench.git /tmp/cooperbench
git -C /tmp/cooperbench checkout --detach 63b9d44d9f39a02fccf5bf0052db48a917a011fd
docker pull akhatua/cooperbench-pallets-click:task2800
python3 tools/benchmarks/cooperbench.py --checkout /tmp/cooperbench \
  --output /tmp/cooperbench-reference --reference
```

If the Docker client uses a nondefault socket, set `DOCKER_HOST` to the active
context's endpoint before running Python. For example, on Colima use
`export DOCKER_HOST="$(docker context inspect colima --format '{{.Endpoints.docker.Host}}')"`.

The reference run uses Click task 2800, features 2 and 6, from the `lite` subset.
Their separate reference patches merge and pass both test suites. To score Minions
or Paperclip outputs, use `--patches FIRST.patch SECOND.patch` in place of
`--reference` and give each platform its own new `--output` directory. Use
`--repo`, `--task`, and `--features FIRST SECOND` to select a different pair and
pull its matching upstream task image first. Keep the dataset's reference patches
and grader tests outside the workers' workspaces during live comparisons.

### Replay the native review gate

Use the read-only replay command on a completed CooperBench treatment run:

```sh
node tools/benchmarks/cooperbench-native-review-replay.mjs --run-dir /path/to/treatment
node --test tools/benchmarks/cooperbench-native-review.test.mjs
```

The run directory contains `fixture.json`, `regression.json`, `gate.json` and
`gate-evidence/`. Keep the fixture's local Git repository with its immutable
`refs/coopbench` refs available. The command prints the first eligible checkpoint
after verifying the frozen Git candidate, test bytes and stored check results.
It reads existing evidence without running tests or models.

The experimental runner owns this eligibility rule. A distinct peer can finish
testing after local publication and before task registration. The check must pass
on the exact immutable head and the same peer must approve the matching, current
submitted generation within the run budget. A changed head needs new check
evidence. The Minions app records the submission and generation-bound peer
verdict. Its hosted PR and Actions observations are separate from the runner's
local Git refs and pytest receipts.

## Context overhead comparison

After capturing an explicitly selected direct-model run and equivalent Minions
work, compare the numeric records offline:

```sh
node tools/benchmarks/context-overhead-cli.mjs --direct direct.json --minions minions.json --out comparison.json
node --test tools/benchmarks/context-overhead.test.mjs
```

This command does not run inference, open a database or write project analytics. It
requires two JSON records of at most 1 MiB each and an unused output path. Each
record has `mode` (`direct` or `minions`), `provider`, `model`, `effort`,
`clientVersion`, `scenarioDigest`, `fixtureDigest`, `sharedConfigDigest`,
`sessionPhase`, and `turns` (one to 100 entries). All configuration fields must
match between records; shared configuration identifies the native client,
permissions and environment, excluding the deliberate Minions instructions/tool
delivery difference. Digests identify the same scenario and initial fixture state.

Each turn contains measured `input`, `output`, `cacheRead`, `cacheWrite` counters
(integer or `null` for unknown), `inputSemantics` (`uncached` or `includes-cache`)
and `resultDigest`: the SHA-256 of the verified, canonical task result. Verify each
result against the scenario's expected work before writing the digest. Matching
digests are a comparison precondition, not proof that this utility independently
executed or verified the work. Keep provenance and verification evidence with the
experiment/PR; no raw prompts, tool results or credentials belong in these records.

Give the direct model the same required task/conversation facts and steering.
Use a new session in each arm, then pair subsequent steering turns in those same
sessions. Capture actual native usage with its accounting semantics, including
all requests within each paired turn. A subscription price estimate is not a
measured cost. Report signed input-token differences, separate cache/output
differences and unknowns. This establishes a result for the measured scenario;
it does not allocate tokens to individual sources or measure retained context.
The live capture pair is still required; synthetic unit fixtures do not measure
Minions overhead.

### Opt-in native capture

The source-only Codex capture harness reuses the production worker adapter, scoped
MCP service/catalog, prompt builder, protocol collector and native supervision.
Project coordination is synthetic and local; the model is real. No experiment
records enter production analytics. Inspect the fixed scenario without inference:

```sh
node packages/agent-cli/scripts/measure-context-overhead.mjs --describe
```

After the operator explicitly selects an available Codex model and effort and the
bounded scenario, build the connector and run the capture with that selection:

```sh
npm --prefix packages/agent-cli run build
node packages/agent-cli/scripts/measure-context-overhead.mjs --approved --model SELECTED_MODEL --effort SELECTED_EFFORT --expect-platform ACTUAL_PLATFORM --timeout-seconds 180
```

`ACTUAL_PLATFORM` is `darwin`, `win32` or `linux`; Node 24 or newer is required.
There is no default model or effort. The optional `--codex PATH` selects the
installed executable. The duration is a total deadline (30–300 seconds), not a
per-request token or monetary cap. Four controller turns can contain multiple
model requests. This command starts real inference; it is excluded from normal
tests and startup.

Both arms start fresh native sessions in separate temporary checkouts containing
the same `data.json`. Before freezing configuration, a no-input native thread is
opened in each checkout to let the client register workspace trust metadata. No
model turn is submitted during this preparation; measured sessions start fresh
afterward. The direct arm receives task/conversation facts inline;
Minions retrieves the task and conversation through real facade tools. The task
produces `INITIAL.json` with sum 17, then steering changes the adjustment and
produces `STEERING.json` with sum 10, preserving the first result. Each arm's second
turn resumes its first session. Both use the same selected model/effort and native
sandbox/approval settings. Codex must confirm the effort before prompt submission;
unconfirmed or unsupported selections fail without falling back. Configuration
file changes, missing native model identity, changed models, missing required tool
reads and incorrect results invalidate the comparison.

The direct arm uses a controlled native configuration with Minions instructions
and its generated MCP connection removed. Personal MCPs/plugins/hooks remain
disabled in both arms. This is an equivalent controlled baseline, not every
person's customized direct chat. Sequential execution can still vary with cache
state and model sampling; report cache differences separately and repeat selected
scenarios before drawing broader conclusions.

The printed private temporary directory contains both checkouts/native state,
numeric `direct.json`/`minions.json` records and `comparison.json` with verified
result digests and supplied-source measurements. Preserve failed experiments for
private inspection; do not copy native state or transcripts into a PR. CLI errors
omit raw provider text. The normal test suite exercises the harness with fake
clients, writes `realModels: false` and establishes no real overhead result.

Effort uses the documented [Codex App Server turn setting](https://learn.chatgpt.com/docs/app-server#turns)
and the installed protocol's reported reasoning effort. This trusted experiment
option does not add an effort selector to public Minions MCP launch commands.
