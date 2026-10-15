# Repository instructions

Use Nix to get the tools you need. Write README.md in English.

## Development and verification

- Enter the locked environment with `nix develop path:.` (Node.js 24, pnpm).
- Install with `pnpm install --frozen-lockfile`. Keep dependency build scripts disabled in `pnpm-workspace.yaml`.
- Run `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm causal --help`, and `pnpm causal demo` after behavioral changes. Tests use compiled package exports; `pnpm test` builds first.
- Never report a test or demo as passed without actually executing it. Host environments must permit bounded fixture subprocesses; blocked execution is an operational failure, not a passing test.
- Keep lockfiles current. Do not add a second language, server, framework, or dependency without a concrete need.

## Code and architecture

- Use strict TypeScript with explicit interfaces and narrow runtime validation. Preserve `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- `trace-schema` owns data validation, canonicalization and portable semantics; it must not depend on storage or agent execution.
- `recorder` depends only on the schema and exposes `TraceStore` separately from SQLite.
- The example owns its state machine and trusted fixture tools. Replay invokes that same state machine; do not create a second approximate implementation or copy recorded decisions into live forks.
- Experiments verify parent-child references and initial state equivalence. Label deterministic repeats as reproducibility checks, not independent statistical evidence.
- Document schema/replay changes in `docs/`. Version incompatible formats and fixture semantics explicitly.

## Invariants and trust

- Validate event ordering, unique IDs, tool-call/result correlation, terminal placement, snapshot integrity, and intervention lineage.
- Always verify the supported trusted checkpoint before live restoration. Never execute source bytes, commands, paths, modules, or repository scripts supplied by trace data.
- All fixture executions use fresh temporary directories, allowlisted templates and tools, argument-array subprocesses, explicit environments, time/output bounds and permission restrictions. Clean up in `finally`.
- Do not overwrite user files or silently overwrite exports/reports. Retain generated source and snapshots as trace data.
- Keep frozen tool-response replay distinct from live execution. Do not claim recorded test outcomes were rerun during exact replay.
- Filter sensitive fields; do not capture credentials or inherit environments into subprocesses. State the limits of field filtering.
- Preserve the existing Apache-2.0 license.

## Required checks for engine changes

Cover real failing original and passing fork executions, changed source, equivalent initial snapshots, immutable parent history, valid lineage, separate workspaces, unchanged repository files, replay divergence, malformed traces, snapshot tampering and CLI behavior. Do not replace actual assertion execution with hardcoded outcomes. Add checks for new failure modes without duplicating implementation details.
