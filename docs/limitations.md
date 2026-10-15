# Limitations and trust boundaries

## External side effects

Only the fixture's documentation lookup, solution write, and local test are supported. There are no network calls or persistent external mutations to undo. Replacing a recorded response from a real payment API, repository push, or database write would not reverse its side effects. Such tools need an explicit simulation/isolation policy before being integrated.

## Nondeterministic LLM calls

The example has no LLM dependency. It makes a documented deterministic choice between two API observations. Frozen-response replay checks behavior conditioned on the recorded observations; it does not recreate uncontrolled model sampling. An LLM seed alone would not guarantee determinism across provider/model changes. Supporting stochastic agents requires adapter contracts and experiments beyond this MVP.

## Snapshots and environment

Inline snapshots describe only the known fixture files, agent phase/task, lookup version and execution configuration. They omit full OS state, service state, sockets, permissions, installed libraries and arbitrary process memory. The Nix lock supplies reproducible tooling, and the trace records Node/platform/architecture. Exact replay compares runtime metadata and may reject another platform or Node patch version. The pre-documentation boundary is the only supported restart point.

Snapshots are verified against both a SHA-256 fingerprint and the compiled-in trusted fixture. Arbitrary files with valid hashes are not accepted for live continuation. Source bytes and stdout/stderr remain in traces after temporary execution directories are removed. Snapshots are content addressed but there is no separate blob store, deduplication or large-artifact streaming yet.

## Process isolation

The runner executes trusted fixture code, not an imported repository or supplied source. It permits one of two fixed generated solutions, calls an absolute Node binary with argument arrays, uses a new private workspace, strips inherited environment variables, bounds runtime to five seconds and output to 64 KiB, and uses Node permission restrictions with filesystem reads limited to that workspace. It does not use a shell, unrestricted eval, arbitrary commands, network allowances, child-process allowances or worker allowances.

The live driver verifies the expected file inventory and bytes around tool actions, using no-follow reads. Node still reopens modules after verification: concurrent same-user filesystem races are not eliminated. Node permissions and temporary directories are not a security boundary for arbitrary hostile code. There is no container, VM, kernel resource quota, or whole-system filesystem snapshot. A hostile repository runner is intentionally absent. Introduce OS isolation and test its guarantees before extending executable inputs. A host sandbox that blocks subprocess creation/output causes an operational failure; the runner refuses to treat empty output as a test result.

## Recording and data integrity

SQLite receives whole traces atomically after a run finishes or a handled operational failure occurs. A crash or termination before that point can lose in-flight events. WAL and transactions prevent partially committed histories, but there is no crash-recovery journal for the recorder itself.

The storage digest detects accidental event modifications when loading a stored trace; loads and listings also cross-check denormalized metadata against event bodies. It is not a signature, tamper-proof audit system, or proof that a tool truly ran. JSONL has structural validation and snapshot fingerprints but no independently authenticated producer identity. Imports can preserve parent IDs without the parent being present; comparison requires and validates both histories.

Trace import and parsing are local, synchronous operations intended for small histories. There are no streaming trace-size quotas or multi-user access controls. SQL statements are parameterized. Read-only inspection still opens the local database through the same SQLite store; no hosted service is exposed.

## Secrets

The recorder recursively filters sensitive field names before validation/storage and never captures the host environment. The fixture uses synthetic data only. Field-name filtering cannot detect credentials embedded inside free-text source, tool output, exception messages or innocuously named fields. New adapters must restrict what they record. Imported histories preserve their supplied content; do not assume importing sanitizes existing secrets. Generated reports/exports use private file modes; the database relies on a private data directory and the user's filesystem policy.

## Causal interpretation

A failing original and passing fork are a controlled contrast for one fixture and one changed observation. They do not establish universal causation, exclusive attribution, statistical significance or production readiness. Deterministic repeats are not independent evidence. Custom success predicates receive defensive event copies but remain trusted code that can mutate process globals or external state. The experiment API exposes a named success predicate and per-trial metadata, but no confidence intervals or stochastic sampling framework.

## Intentionally deferred

General framework adapters; arbitrary intervention boundaries; external tools; LLM integrations; OS-isolated repository execution; crash-safe incremental recording; signed traces; large blob storage; streaming import; OpenTelemetry export; schema migrations; stochastic evaluation; dashboards; hosted collaboration and Git-like merge semantics.
