# CAUSAL

**A counterfactual debugger for AI agents.** An executable, Apache-2.0 MVP of the longer-term idea “Git for Agent Decisions.”

CAUSAL records a deterministic agent, verifies replay against its recorded tool responses, replaces one documentation observation, and **executes the affected continuation again**. The generated code changes and a real Node.js assertion changes from failing to passing. No LLM key, database server, Docker daemon, or network access is needed to run the installed demo.

A log viewer shows the original failure. CAUSAL also restores a verified checkpoint, runs an alternative decision path, and saves the intervention, both outcomes, source differences, state fingerprints, and parent-child lineage. This supports a controlled experimental contrast, not a claim of universal causal attribution or production readiness.

## Quick start

Install [Nix](https://nixos.org/download/) with flakes enabled. From this repository:

```sh
nix develop path:.
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm causal --help
pnpm causal demo
```

The locked flake supplies Node.js 24 and pnpm. Dependency versions are in `pnpm-lock.yaml`. The first setup needs access to Nix caches and the npm registry. Dependency build scripts are disabled; the platform-specific esbuild package supplies Vitest's executable. The CLI runs built JavaScript; rebuild after editing source. `path:.` also includes local files that have not been added to Git yet.

`pnpm causal` is the repository-local form of `causal`; no global install is needed. You can also run `node packages/cli/dist/index.js demo`.

## Complete demonstration

```sh
pnpm causal demo --trials 2
```

The demo performs these steps:

1. Makes a unique temporary workspace containing the trusted `auth.login()` fixture library and assertion runner.
2. Records the documentation tool call and a checkpoint immediately before its response.
3. Receives `{"api":"auth.loginLegacy()"}`, chooses that API, writes `solution.mjs`, and runs the assertion in a bounded child process. The test fails with a real `TypeError`.
4. Saves the original trace in SQLite and re-executes the agent against frozen tool responses. Ordered events, decisions, outputs, and snapshot fingerprints must match after removing IDs and wall-clock timestamps.
5. Selects the original `docs.lookup` result event, verifies its checkpoint, and restores the same initial files into a different temporary workspace.
6. Replaces exactly that response with `{"api":"auth.login()"}`. The state machine chooses the corrected API, writes different code, and runs the real assertion successfully.
7. Saves new child traces and JSON/text reports. Deletes execution workspaces, retaining source bytes and snapshots in the traces.

Example output (IDs abbreviated here):

```text
Original <original-id>: FAIL (exit 1)
FAIL TypeError: auth.loginLegacy is not a function
Counterfactual <fork-id>: PASS (exit 0)
PASS authentication
Intervention <fork-id>:3: {"api":"auth.loginLegacy()"} -> {"api":"auth.login()"}
Generated source changed: true; final state changed: true
Success-rate difference: +1 (deterministic fixture)
...
Exact recorded replay: equivalent (12 events; frozen tools)
Saved JSON, text, and JSONL traces: .../.causal/reports/<original-id>
```

The report directory contains `report.json`, `report.txt`, and one `<trace-id>.jsonl` per run. `report.json` includes all trial IDs, test exit codes/output, generated source, decisions, state differences, intervention values, checkpoint fingerprint, replay guarantees, and explicit limitations. Repeated trials check reproducibility; they are **not independent statistical evidence**.

By default only `.causal/` is created in the current directory. Agent code and tests run under fresh system temporary directories, never over project files. `--db` and `--out` select other locations. Output files use exclusive creation and will not overwrite existing files.

## CLI

Global options: `--db <path>` (default `.causal/traces.sqlite`), `--json`, `--help`.

```sh
pnpm causal record                       # Save just the original failing run
pnpm causal traces
pnpm causal inspect <trace-id> --json
pnpm causal replay <trace-id>
pnpm causal fork <trace-id> --event <event-id> \
  --replacement examples/broken-auth-agent/corrected-docs.json
pnpm causal compare <original-trace-id> <fork-trace-id>
pnpm causal export <trace-id> --out /tmp/original.jsonl
pnpm causal import /tmp/original.jsonl --db /tmp/portable.sqlite
pnpm causal demo --db /tmp/demo.sqlite --out /tmp/new-report-directory --json
```

Use the **`tool.completed` event whose tool is `docs.lookup`** from `inspect` as the intervention target. The replacement file must be exactly an object with `api` equal to `auth.login()` or `auth.loginLegacy()`. Unsupported targets, no-op replacements, malformed data, and unknown IDs fail with diagnostics and a nonzero exit status. A fixture test failure is an experimental outcome, so `record` and `demo` return zero when recording succeeds. Operational failures return nonzero. JSON mode emits JSON results to stdout and JSON errors to stderr; package-manager status messages may be separate from the CLI output. Invoke Node directly when capturing stdout in scripts.

Imports validate and preserve trace data; they never execute imported code. Import parent traces separately when you want to compare portable parent-child pairs. Traces are immutable: importing a duplicate ID fails.

## Components

| Location | Responsibility |
| --- | --- |
| `packages/trace-schema` | Versioned Zod schemas, ordering/correlation checks, recursive field redaction, canonical SHA-256 fingerprints, JSONL |
| `packages/recorder` | Recorder and storage interface; transactional SQLite implementation with integrity digests |
| `examples/broken-auth-agent` | Trusted deterministic state machine, executable fixture library, constrained process runner |
| `packages/replay-engine` | Frozen-response deterministic re-execution and live counterfactual continuation |
| `packages/experiment-engine` | Named success predicates, repeated trials, validated lineage, outcome/source/state comparison |
| `packages/cli` | Record, demo, inspect, replay, fork, compare, import/export commands |
| `tests/integration` | Schema, persistence, replay, isolation, real execution, and CLI integration coverage |

The agent is deliberately small: it maps one of two validated documentation responses to one of two trusted source templates. It does not copy downstream decisions from the parent trace. This fixture makes the replay and intervention semantics testable without an external model.

## Limitations and trust boundary

- Exact recorded replay re-executes the state machine with frozen tools. It does **not** re-run the original test or prove a recorded tool output was truthful. Live original/fork runs do execute tests.
- Only the trusted fixture's pre-documentation checkpoint is restartable. Arbitrary agent frameworks, repositories, code, commands, snapshots, and tool replacements are unsupported.
- The child process uses an absolute Node executable, argument arrays, a five-second timeout, a 64 KiB output bound, explicit environment variables, a dedicated workspace, and Node permission restrictions. This is **not an OS security sandbox**. Arbitrary repository execution would require an additional isolation layer.
- Snapshots include the fixture files, agent phase/task, tool version, configuration, and content fingerprint. They do not capture a whole OS, filesystem permissions, networks, services, or external side effects.
- Replay requires the same runtime/platform metadata; the Nix lock pins the supplied tools. Wall-clock timestamps and run/event IDs are excluded from equivalence; parent-event topology is retained.
- The recorder redacts nested fields matching password, secret, token, authorization, cookie, and API-key names. It never captures the process environment. Field filtering cannot recognize secrets embedded in free text. Imported traces retain their supplied fields.
- Complete traces are committed atomically; a hard process crash before commit can lose the in-progress recording. Integrity hashes detect accidental changes; they do not prevent malicious rewriting or provide signatures.

See [architecture](docs/architecture.md), [trace format](docs/trace-format.md), [replay semantics](docs/replay-semantics.md), and [limitations](docs/limitations.md).

## Roadmap

The next milestone is a second deterministic adapter with an explicit serialized state contract and a second intervention boundary, tested against the same conformance suite. After that: crash-safe incremental recording, content-addressed large artifacts, OS-isolated repository execution, then opt-in LLM/tool adapters with explicit nondeterminism and side-effect policies. Stochastic experiment design and confidence intervals require a different evaluation model; they are intentionally deferred.

Licensed under [Apache-2.0](LICENSE).
