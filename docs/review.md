# Correctness review of the MVP

Reviewed the implementation at `6fdf850` and applied focused corrections. This review concerns the single trusted deterministic fixture, not general agent debugging. No new product features or execution adapters were added.

## Method and baseline

Inspected the actual schema, recorder/SQLite store, fixture state machine and live process driver, replay/continuation engine, experiment engine, CLI, build configuration and tests. Ran the existing build, strict source/test type checks, 19 tests and CLI help through the locked Nix toolchain. All passed before the review.

Added an adversarial suite before changing engine code. Its first run produced **17 failures and 7 passes**; the original 19 tests still passed. The failures below were reproduced through executable tests rather than inferred solely from documentation.

## Confirmed defects and corrections

Severity reflects integrity consequences within the MVP's local, trusted-process scope; these are not claims of remote exploitability.

| Severity | Confirmed problem | Reproduction and correction |
| --- | --- | --- |
| High | The disk workspace could differ from the recorded snapshot and allowlisted write. A changed assertion runner could print PASS without testing the solution. Changed library/solution bytes, extra files and an in-workspace symlink were also accepted. | Five tampering cases were accepted before the fix. The live driver now checks the exact inventory and trusted file bytes before every tool action and after writes/tests. File reads use no-follow, nonblocking descriptors with regular-file and size checks. The regressions require rejection **before any subprocess is launched**. |
| High | Exported fixture constants were mutable, so an in-process caller could change what was considered the trusted fixture or API template. | Freeze checks failed for the library/runner map and documentation constants. They are now frozen; constructor responses are parsed into private copies. This protects integrity against accidental in-process mutation, not arbitrary code already running in the same process. |
| High | Canonical hashing silently discarded `__proto__` keys through Zod record parsing. Distinct supplied JSON values could have the same representation and fingerprint. | `canonical(JSON.parse('{"__proto__":{"hidden":"value"}}'))` returned `{}` before the fix. JSON and snapshot-file records now reject that reserved key before parsing. Existing ordinary trace bytes and fingerprints remain unchanged. |
| High | SQLite's JSON digest did not cover the consistency of denormalized metadata/index columns. `outcome`, `parent_id`, `event_id`, or a final row's `sequence` could be changed without load detecting it. Listing trusted metadata directly. | Four corruption tests failed before the fix. Loads now cross-check row identifiers, ordering, queried trace ID, parent ID and outcome against validated event bodies. Listing validates each source history instead of trusting cached metadata. |
| Medium | `Recorder.emit()` returned the same mutable event object retained in history. | Changing the returned start-event runtime also changed recorded history. Returned events are now defensive copies. |
| Medium | A forged child could use its own parent trace ID; direct execution/import could describe a no-op as an intervention. | Both histories were accepted before the fix. Validation rejects self-parent lineage and equal original/replacement values. Existing valid parent-child traces retain their format. |
| Medium | A handled failure before `intervention.applied` could not be persisted because validation required the intervention even for an aborted fork. | A checkpoint mismatch produced an aggregate persistence failure and lost the failed history. Validation now permits an operationally failed fork with zero applied interventions, while a normally completed fork still requires exactly one. The regression checks the original diagnostic and persisted `run.failed`. |
| Medium | The generic validator permitted normal completion after a structured tool error. | An errored documentation result with a normal terminal event was accepted. Version 1 now rejects that contradictory fixture history; failed assertions remain normal completed experiments with `success: false`. |
| Medium | A success predicate could mutate its event-array argument, corrupting the original or trial evidence used later in the experiment. | A predicate clearing the supplied history caused the experiment to fail and changed caller-owned data. Predicates now receive defensive copies, the original is validated/copied first, and the result must be a boolean. Predicates remain trusted executable callbacks. |

The old parent-output forgery test depended on validation order: its replacement of `original` with `replacement` is now rejected earlier as a no-op. The test now forges an extra original-output field so it still independently exercises exact parent-output matching, rather than merely relaxing its expected diagnostic.

## Execution, restoration and replay evidence

The subprocess observation test wraps the real `spawnSync` and delegates to it; it does not replace the results. It captures the workspace files, Node arguments and environment at both actual launches. It verifies:

- Two real assertion subprocesses execute, with original exit 1 and fork exit 0.
- Their on-disk `solution.mjs` bytes match the respective recorded sources and differ from each other.
- Library and assertion-runner bytes match exactly across separate workspace directories.
- The fork makes fresh documentation, write and test tool calls. The original history remains byte-equivalent after the fork.
- The child environment contains only `TZ`, `LANG`, and the workspace-specific `HOME`; runtime/output bounds and Node permission flags are present.
- Both workspaces are removed afterward. The original integration test additionally hashes repository source/configuration files before and after the experiment.

The existing reverse-intervention test executes a successful child with the legacy observation again and gets a real failure. This guards against a fork path that simply hardcodes success.

Replay tests change fork-local event IDs/timestamps, transport JSONL into another SQLite path, and preserve successful normalized replay. Paths do not enter the portable events. Changing runtime metadata deliberately fails equivalence: version 1 conservatively requires the same Node/platform/architecture. Parent-reference IDs and deterministic tool-call IDs remain significant; local run/event identifiers are normalized. Internally consistent but stale final snapshots are rejected, as is an intervention whose recorded downstream observation differs from its declared replacement.

CLI export tests confirm that exclusive writes reject existing files and symlinks without changing their targets. This does not establish safety for every possible filesystem race or default database directory configuration.

## Remaining limits and unverified assumptions

1. **Frozen-response replay cannot authenticate a recorded outcome.** A new explicit test changes a failed original's test tool response, test event and terminal success consistently. Replay accepts it, correctly reporting `externalToolsReexecuted: false`. A trace can be structurally and behaviorally consistent but fabricated. Imported reports are conditional on the supplied evidence; hashes are not signatures or proof of execution.
2. **Filesystem checks are not OS isolation.** Node reopens modules after verification, leaving a time-of-check/time-of-use window against a concurrent hostile process with access to the same directory. No-follow descriptor reads do not close every ancestor-directory race. No hostile-repository execution is authorized or supported.
3. **Environment equivalence is fixture-scoped.** Observed library/runner bytes, configuration and explicit child environment agree; temporary paths intentionally differ. Kernel state, binary/library provenance beyond the pinned environment, locale implementation, resource availability and all process state are not snapshotted. Only Linux x86_64 was executed in this review; Darwin/ARM outputs remain unverified.
4. **Snapshots remain narrow and partly derived.** Final snapshots are built from state-machine expectations, with the live driver now verifying those bytes on disk. There is no general filesystem capture/restore, in-memory agent serialization or external tool-state rollback. Only the initial documentation boundary exists; restart reconstruction is correct for that pure lookup, not a general side-effectful tool.
5. **The producer and test runner share implementation assumptions.** A fixture/renderer/normalizer bug can be correlated across recording and replay. Direct subprocess/file observation and adversarial tape changes reduce this blind spot; they are not independent verification of all semantics. No exhaustive mutation-testing campaign was run.
6. **Callbacks are trusted process code.** Defensive event copies do not prevent a success predicate from modifying globals, environment, filesystem or other external state. No deterministic/purity guarantee is made for custom predicates.
7. **Persistence and scale remain limited.** Complete histories commit only at the end; hard crashes lose in-flight events. Failed report generation can leave already committed traces and partial new report files. Generic import/storage validation is not a full fixture semantic check; replay/compare provide that check. Recording repeatedly validates the prefix; listing now fully validates all histories. These costs are acceptable for the tiny fixture, not assessed at scale.
8. **File and secret handling have boundaries.** Explicitly selected database/output directories, ancestor symlinks, filesystem policy and same-user interference are trusted. Imported free text may contain secrets; field redaction is not data-loss prevention. No multi-user threat model is implemented.
9. **Causal claims remain conditional.** One observation changes one deterministic fixture outcome under controlled relevant state. Repeated identical trials are reproducibility checks, not independent statistical evidence or a general causal-attribution result. No confidence intervals or production-readiness claims are supported.

## Reproduce

```sh
nix develop path:.
pnpm build
pnpm typecheck
pnpm test
pnpm causal --help
pnpm causal demo --trials 2
```

For this managed workspace, Nix uses a writable cache and subprocess tests require sandbox escalation; see the executed command and final results in `docs/validation.md`. The final suite passed **46 tests across 2 files** (27 adversarial and 19 original); strict type checking, build, CLI help and a real two-trial demo passed. Additional same-byte symlink and post-test drift tests verify that checks are not merely detecting an extra filename or an earlier write. The regression suite is `tests/integration/adversarial.test.ts`, alongside the original integration suite. The fresh report is `.causal/reports/ab64582c-dc59-4697-8267-c23365f408f9/report.json`; exact commands and outcomes are in `docs/validation.md`.
