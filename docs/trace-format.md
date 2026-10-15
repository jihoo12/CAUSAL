# Trace format (schema version 1)

A trace is a nonempty, ordered sequence of validated JSON objects. JSONL uses one complete event per line and a trailing newline. Empty interior lines, invalid JSON, unknown fields, unsupported schema versions and incomplete histories are rejected. Source and snapshot bytes are embedded, so exports do not depend on workspace paths.

## Envelope

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Literal `1`; incompatible versions fail explicitly |
| `traceId` | UUID identifying the run |
| `eventId` | Unique within the trace; recorder emits `<traceId>:<sequenceNumber>` |
| `sequenceNumber` | Zero-based contiguous ordering, independent of timestamps |
| `eventType` | Discriminator for the typed payload |
| `timestamp` | UTC ISO date/time; ignored for replay equivalence |
| `parentEventId` | Optional preceding local event; never an external parent trace event |
| `payload` | Strict event-specific object |

## Payloads

| Event | Payload |
| --- | --- |
| `run.started` | Fixture identity, execution configuration, Node/platform/architecture metadata, optional lineage |
| `agent.decision` | Selected API and SHA-256 source fingerprint |
| `tool.called` | Trace-local call ID, tool identity, input JSON, executor version |
| `tool.completed` | Same call ID/tool identity, output JSON; optional structured error (then output is null) |
| `state.checkpoint` | Agent/task phase, files, tool state, configuration, snapshot fingerprint |
| `intervention.applied` | Parent trace ID, target result event ID, original/replacement values, checkpoint fingerprint |
| `test.completed` | Passed boolean, actual exit code, stdout/stderr |
| `run.completed` | Success boolean and final snapshot fingerprint |
| `run.failed` | Operational failure diagnostic |

Tools are `docs.lookup`, `workspace.write`, and `tests.run`. The fixture accepts only `{"api":"auth.loginLegacy()"}` and `{"api":"auth.login()"}` as documentation results. Arbitrary JSON outputs are representable in the generic tool schema, but fixture adapters perform narrower validation.

The original trace has 12 events: start, documentation call, boundary checkpoint, documentation result, decision, write call/result, test call/result, test outcome, final checkpoint, completion. A fork has 13: an additional intervention between boundary checkpoint and documentation result. Tool requests/results correlate by call ID and parent event ID. Source writes refer to the decision; tests refer to the write result.

Lineage is represented in `run.started.payload.lineage` and `intervention.applied`, rather than using a local `parentEventId` to refer outside the trace. The intervention's own event ID is the durable identifier for the change. Comparison verifies the reference against the actual parent history. Self-parent lineage and equal original/replacement values are invalid. An operationally failed fork may have no intervention event when it stopped before the boundary; a normal completion requires exactly one. Version 1 also rejects normal completion following an errored tool.

## Canonicalization and integrity

Canonical JSON recursively sorts object keys, preserves array order and string bytes, and rejects nonfinite numbers, non-JSON values and reserved `__proto__` keys that record parsing would otherwise drop. SHA-256 fingerprints cover that canonical representation. Snapshot fingerprints omit the fingerprint field itself. SQLite integrity digests include all event metadata, including timestamps and IDs; replay equivalence deliberately omits those metadata fields while retaining parent topology as sequence references.

Snapshots restrict filenames to flat lowercase `.mjs` names. Live restoration additionally requires the exact trusted initial fixture contents and configuration. A freshly recomputed hash alone cannot authorize executable bytes. Compiled-in fixture trust anchors are frozen; the live driver verifies the exact inventory and expected bytes before execution.

The recorder recursively replaces values of fields whose names match password, secret, token, authorization, cookie, or API-key patterns with `[REDACTED]` before validation/storage. The process environment is never recorded. This does not inspect free-text content; adapters must avoid putting sensitive strings in source, stdout, stderr or diagnostics. Import validates existing histories without rewriting their contents.

Version 1 rejects unknown payload fields to catch mistakes. Future compatibility should use explicit schema/adapter versions and migrations. Trace/span mapping for OpenTelemetry and schema negotiation are deferred.
