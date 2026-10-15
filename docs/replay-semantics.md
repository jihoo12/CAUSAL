# Replay semantics

CAUSAL distinguishes four operations. The CLI reports the specific operation and its limits.

## Event playback

`inspect` loads and displays recorded events. JSONL export/import transports them. No decision is computed and no tool runs. This is useful for observation but says nothing about the behavior of an alternative execution.

## Exact recorded replay: deterministic state-machine re-execution

`replay` validates the history and checkpoint, creates an in-memory tool-response tape, and invokes the same fixture state machine used for live runs. Each requested tool identity and canonical input must match the next recorded request. Its corresponding recorded response is returned without calling a live tool.

The state machine recomputes the API choice, source, tool requests, test-outcome event, and final state. Canonical comparison then checks all event types, sequence numbers, payloads, parent topology, outputs and checkpoint fingerprints. Run/event IDs and wall-clock timestamps are excluded. Fork references to external parent IDs remain part of payloads and are preserved. Runtime/platform metadata is significant; the same supported environment is required.

This is stronger than displaying a log: changing a recorded decision, request input, final state or ordering can cause replay divergence. It is intentionally weaker than re-running all external actions: the write and test results come from the tape, no workspace is created, and no assertion process runs. A consistent but fabricated response tape cannot be disproved by this mode. Digests are not attestations of truth.

Operationally failed traces are inspectable/exportable but not exactly replayable in this fixture. Failure timing and arbitrary tool exceptions have no deterministic replay contract yet.

## Counterfactual continuation

`fork` first checks recorded replay equivalence for the parent. The target must be a `docs.lookup` tool-result event at the supported pre-documentation checkpoint. The replacement must satisfy the documentation schema and differ from the original.

The checkpoint contains:

- Agent state: `awaiting-documentation` and task `implement-auth`.
- Workspace state: trusted `auth.mjs` and `test.mjs` source.
- Tool state: the lookup fixture version.
- Configuration: fixture version and Node major version.
- A canonical content fingerprint.

The live driver verifies the fingerprint and exact supported contents, restores them in a new directory, and verifies restored bytes. The pending documentation-call envelope is reconstructed in the child history. This reconstruction does not repeat the parent's lookup or any earlier side effect: in this fixture the lookup is a pure local constant. The fork records one intervention and supplies its replacement observation.

All downstream decisions are recomputed; a live file write and a real assertion process follow. The child history contains a new trace ID, parent trace ID, target event ID, original/replacement observations and checkpoint fingerprint. The intervention event itself has a new event ID. Comparisons check those links against the parent history. Forks can themselves be replayed and forked at their supported documentation boundary.

A failed original and passing fork demonstrate that the substituted observation changes this fixture's behavior under equivalent starting state and fixed code/environment. The report includes the resulting source and outcome differences. No downstream original decision is reused as a fresh result.

## Real-world causal inference

The controlled contrast is evidence about this specific intervention in this deterministic fixture. It does not establish that a documentation choice is the sole cause of a real agent failure, estimate performance on other tasks, or prove that similar interventions generalize.

Repeated identical executions test reproducibility, not independent sampling. Reports set `independentStatisticalEvidence: false`; success-rate differences are descriptive fractions, not estimates with fabricated confidence intervals. Future stochastic adapters need explicit sampling assumptions, seeds where available, side-effect controls, experimental design and uncertainty estimates.
