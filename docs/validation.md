# Executed validation

Verified on 2026-10-15 (Asia/Seoul) on Linux x86_64 using the locked Nix environment: Node.js 24.21.0, pnpm 12.9.0, TypeScript 5.9.3, Vitest 3.2.7.

The final verification executed:

```sh
XDG_CACHE_HOME=/tmp/causal-nix-cache nix develop path:. --command bash -c 'pnpm install --frozen-lockfile --store-dir /tmp/causal-pnpm-store && pnpm build && pnpm typecheck && pnpm test && pnpm causal --help && pnpm causal demo --trials 2'
```

The cache/store overrides accommodate this workspace's filesystem permissions; ordinary installations can use the README commands without them. The managed workspace sandbox blocked Node subprocess pipes, so fixture execution and the final suite ran with approved sandbox escalation. Only the fixed, trusted fixture sources were executed. The runner explicitly rejects missing subprocess output as an operational failure, covered by a regression test.

Results:

- Locked dependency installation succeeded with dependency build scripts disabled.
- TypeScript build and strict type checking of both source and tests succeeded.
- Vitest: **19 tests passed, 1 test file passed**, final run duration 2.00 seconds.
- CLI help succeeded; the suite also exercised record/replay/inspect/fork/compare/import/export behavior through separate processes (the original recording is created by `demo`).
- Original actual assertion: exit 1, `FAIL TypeError: auth.loginLegacy is not a function`.
- Two live counterfactual trials: exit 0, `PASS authentication`, with distinct trace IDs and changed generated source.
- Exact recorded replay: 12 normalized events equivalent, tools frozen.
- Integration checks confirmed separate temporary workspaces, cleanup, parent-child linkage, equivalent starting snapshots, and unchanged repository source/configuration files.
- An additional real reverse-intervention test changed a successful child back to the legacy API and observed failure again.

The final demo saved these local artifacts (intentionally ignored by Git):

```text
.causal/traces.sqlite
.causal/reports/679e2236-9118-450a-a748-c22650f1264c/report.json
.causal/reports/679e2236-9118-450a-a748-c22650f1264c/report.txt
.causal/reports/679e2236-9118-450a-a748-c22650f1264c/679e2236-9118-450a-a748-c22650f1264c.jsonl
.causal/reports/679e2236-9118-450a-a748-c22650f1264c/55b2ed3d-d3d3-4ee0-b02c-5355245053c8.jsonl
.causal/reports/679e2236-9118-450a-a748-c22650f1264c/f4d42aa3-ceab-45ff-b5f1-32ae8831698f.jsonl
```

Fresh runs create new IDs and timestamps. Identical deterministic trial outcomes are reproducibility checks, not independent statistical evidence. These checks establish the documented fixture behavior, not production readiness or general causal debugging.
