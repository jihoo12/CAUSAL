import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonical, eventSchema, exportJsonl, fingerprint, importJsonl, normalize, redact, validateTrace, verifySnapshot } from '../../packages/trace-schema/dist/index.js';
import type { ExecutionEvent } from '../../packages/trace-schema/dist/index.js';
import { Recorder, SqliteTraceStore } from '../../packages/recorder/dist/index.js';
import { correctedDocs, executeAgent, initialSnapshot, LiveFixtureDriver, runLive, verifyBoundary } from '../../examples/broken-auth-agent/dist/index.js';
import { exactReplay, forkTrace } from '../../packages/replay-engine/dist/index.js';
import { compare, experiment } from '../../packages/experiment-engine/dist/index.js';

const cleanup: string[] = [];
function temp(): string { const path = mkdtempSync(join(tmpdir(), 'causal-test-')); cleanup.push(path); return path; }
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function target(events: ExecutionEvent[]): string {
  return events.find(e => e.eventType === 'tool.completed' && e.payload.tool === 'docs.lookup')!.eventId;
}
function mutate(events: ExecutionEvent[], fn: (events: ExecutionEvent[]) => void): ExecutionEvent[] {
  const copy = structuredClone(events); fn(copy); return copy;
}
function repoDigest(): string {
  // Includes all source, configuration and tracked project files; excludes only generated data and environment mounts.
  const skip = new Set(['.git', '.agents', '.aws', '.codex', 'node_modules', 'dist', '.causal']);
  const files: Record<string, string> = {};
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[path] = readFileSync(path).toString('base64');
    }
  }
  visit(resolve('.')); return fingerprint(files);
}

describe('versioned trace schema and recorder', () => {
  it('validates events, rejects unknown versions, unknown payload fields and invalid test statuses', () => {
    const events = runLive().events;
    expect(eventSchema.parse(events[0]).schemaVersion).toBe(1);
    expect(() => eventSchema.parse({ ...events[0], schemaVersion: 2 })).toThrow();
    expect(() => eventSchema.parse({ ...events[0], timestamp: 'yesterday' })).toThrow();
    expect(() => eventSchema.parse({ ...events[0], unexpected: true })).toThrow();
    const test = events.find(e => e.eventType === 'test.completed')!;
    expect(() => eventSchema.parse({ ...test, payload: { passed: true, exitCode: 1, stdout: '', stderr: '' } })).toThrow();
  });
  it('assigns stable sequence numbers, validates ordering, parent links, tool correlations and terminals', () => {
    const events = runLive().events;
    expect(events.map(e => e.sequenceNumber)).toEqual(events.map((_, i) => i));
    expect(() => validateTrace(mutate(events, e => { e[1]!.sequenceNumber = 3; }))).toThrow(/ordering/);
    expect(() => validateTrace(mutate(events, e => { e[1]!.traceId = randomUUID(); }))).toThrow(/Mixed/);
    expect(() => validateTrace(mutate(events, e => { e[1]!.parentEventId = 'future'; }))).toThrow(/Parent/);
    expect(() => validateTrace(mutate(events, e => { e[3]!.parentEventId = e[0]!.eventId; }))).toThrow(/Unmatched/);
    expect(() => validateTrace(events.slice(0, -1))).toThrow(/Incomplete/);
    expect(() => validateTrace([...events, { ...events[1]!, sequenceNumber: events.length, eventId: 'late' }])).toThrow(/terminal/);
  });
  it('filters secret fields recursively before persistence without inheriting environment variables', () => {
    expect(redact({ api_key: 'a', nested: [{ authorization: 'b', password: 'c', public: 'ok' }] })).toEqual({ api_key: '[REDACTED]', nested: [{ authorization: '[REDACTED]', password: '[REDACTED]', public: 'ok' }] });
    const r = new Recorder();
    r.emit('run.started', { agent: 'broken-auth-v1', config: initialSnapshot().config, runtime: { node: process.versions.node, platform: process.platform, arch: process.arch } });
    r.emit('tool.called', { callId: 'x', tool: 'docs.lookup', input: { token: 'do-not-store' }, metadata: { executor: 'fixture-v1' } });
    expect(JSON.stringify(r.events())).not.toContain('do-not-store');
    const history = r.events(); history.pop(); expect(r.events()).toHaveLength(2);
  });
  it('round-trips portable JSONL and rejects malformed, incomplete, mixed or corrupt data', () => {
    const events = runLive().events;
    expect(importJsonl(exportJsonl(events))).toEqual(events);
    expect(() => importJsonl('{bad json}\n')).toThrow(/Invalid JSONL/);
    expect(() => importJsonl(exportJsonl(events).split('\n').slice(1).join('\n'))).toThrow();
    expect(() => importJsonl('')).toThrow();
  });
});

describe('SQLite persistence', () => {
  it('commits immutable traces, reloads across connections, and rejects a modified record', () => {
    const path = join(temp(), 'traces.sqlite');
    const events = runLive().events;
    const store = new SqliteTraceStore(path);
    store.save(events);
    expect(() => store.save(events)).toThrow();
    expect(store.list()).toMatchObject([{ traceId: events[0]!.traceId, outcome: 'failure', eventCount: events.length }]);
    store.close();
    const reopened = new SqliteTraceStore(path);
    expect(reopened.load(events[0]!.traceId)).toEqual(events);
    expect(() => reopened.load(randomUUID())).toThrow(/Unknown trace/);
    const raw = new DatabaseSync(path);
    const first = { ...events[0]!, timestamp: '2020-01-01T00:00:00.000Z' };
    raw.prepare('UPDATE events SET body = ? WHERE sequence = 0').run(JSON.stringify(first)); raw.close();
    expect(() => reopened.load(events[0]!.traceId)).toThrow(/integrity/);
    reopened.close();
  });
});

describe('replay and snapshot invariants', () => {
  it('re-executes agent decisions using frozen tool responses without calling live tools', () => {
    const original = runLive();
    vi.spyOn(LiveFixtureDriver.prototype, 'perform').mockImplementation(() => { throw new Error('Live tools forbidden during replay'); });
    expect(exactReplay(original.events)).toMatchObject({ equivalent: true, externalToolsReexecuted: false });
    expect(existsSync(original.workspace)).toBe(false);
  });
  it('ignores ID and timestamp metadata but preserves normalized parent topology', () => {
    const events = runLive().events;
    const traceId = randomUUID();
    const ids = new Map(events.map(e => [e.eventId, randomUUID()]));
    const changed = events.map(e => ({ ...e, traceId, eventId: ids.get(e.eventId)!, timestamp: '2020-01-01T00:00:00.000Z',
      ...(e.parentEventId ? { parentEventId: ids.get(e.parentEventId)! } : {}) }));
    expect(normalize(changed)).toEqual(normalize(events));
    expect(exactReplay(changed).equivalent).toBe(true);
  });
  it('detects divergence in recorded decisions, tool inputs and state', () => {
    const events = runLive().events;
    const decision = mutate(events, es => { const e = es.find(e => e.eventType === 'agent.decision'); if (e?.eventType === 'agent.decision') e.payload.sourceHash = '0'.repeat(64); });
    expect(() => exactReplay(decision)).toThrow(/equivalence/);
    const inputs = mutate(events, es => { const e = es.find(e => e.eventType === 'tool.called'); if (e?.eventType === 'tool.called') e.payload.input = { topic: 'tampered' }; });
    expect(() => exactReplay(inputs)).toThrow(/diverged/);
  });
  it('verifies snapshot fingerprints and rejects recomputed malicious or traversing snapshots', () => {
    const changed = initialSnapshot(); changed.files['auth.mjs'] = 'malicious';
    expect(() => verifySnapshot(changed)).toThrow(/integrity/);
    const { fingerprint: _hash, ...body } = changed;
    changed.fingerprint = fingerprint(body);
    expect(() => verifyBoundary(changed)).toThrow(/trusted/);
    expect(() => new LiveFixtureDriver(changed)).toThrow(/trusted/);
    const badPath = initialSnapshot(); badPath.files['../escape.mjs'] = 'x';
    const { fingerprint: _otherHash, ...badBody } = badPath; badPath.fingerprint = fingerprint(badBody);
    expect(() => verifySnapshot(badPath)).toThrow(/Unsafe snapshot path/);
  });
  it('rejects nonexistent, non-tool and unsupported tool targets, invalid replacements and no-op forks', () => {
    const events = runLive().events;
    for (const id of ['missing', events[0]!.eventId, events.find(e => e.eventType === 'tool.completed' && e.payload.tool === 'tests.run')!.eventId]) {
      expect(() => forkTrace(events, id, correctedDocs)).toThrow(/Invalid intervention target/);
    }
    expect(() => forkTrace(events, target(events), { api: 'process.exit()' })).toThrow();
    expect(() => forkTrace(events, target(events), { api: 'auth.login()', source: 'untrusted' })).toThrow();
    expect(() => forkTrace(events, target(events), { api: 'auth.loginLegacy()' })).toThrow(/differ/);
  });
  it('rejects executable tool data outside trusted templates and cleans up the workspace', () => {
    const driver = new LiveFixtureDriver(initialSnapshot());
    try {
      expect(() => driver.perform('workspace.write', { path: 'solution.mjs', contents: 'process.exit(0)' })).toThrow(/trusted/);
      expect(existsSync(join(driver.workspace, 'solution.mjs'))).toBe(false);
    } finally { driver.close(); }
    expect(existsSync(driver.workspace)).toBe(false);
  });
  it('treats missing subprocess output as an operational error and persists the diagnostic', () => {
    const directory = temp();
    const store = new SqliteTraceStore(join(directory, 'errors.sqlite'));
    vi.spyOn(childProcess, 'spawnSync').mockReturnValue({ pid: 1, output: [null, '', ''], stdout: '', stderr: '', status: 0, signal: null });
    syncBuiltinESMExports();
    expect(() => runLive({ store })).toThrow(/no valid test result/);
    expect(store.list()[0]!.outcome).toBe('error');
    const events = store.load(store.list()[0]!.traceId);
    expect(events.some(e => e.eventType === 'test.completed')).toBe(false);
    store.close();
  });
  it('records operational failures distinctly, cleans workspaces and never reports them as fixture outcomes', () => {
    const store = new SqliteTraceStore(':memory:');
    expect(() => executeAgent({ perform: () => { throw new Error('Tool unavailable'); } }, { store })).toThrow('Tool unavailable');
    expect(store.list()[0]!.outcome).toBe('error');
    const failed = store.load(store.list()[0]!.traceId);
    expect(failed.at(-1)?.eventType).toBe('run.failed');
    expect(failed.find(e => e.eventType === 'tool.completed')?.payload).toMatchObject({ output: null, error: { name: 'Error', message: 'Tool unavailable' } });
    expect(() => exactReplay(failed)).toThrow(/Operationally failed/);
    store.close();
  });
});

describe('real counterfactual continuation', () => {
  it('persists a failing original, restores equivalent state, executes different code successfully, and leaves repository files untouched', () => {
    const before = repoDigest();
    const path = join(temp(), 'history.sqlite');
    const store = new SqliteTraceStore(path);
    const original = runLive({ store });
    expect(original.test).toMatchObject({ passed: false, exitCode: 1, stderr: '' });
    expect(original.test.stdout).toContain('auth.loginLegacy is not a function');
    const persisted = store.load(original.events[0]!.traceId);
    const fork = forkTrace(persisted, target(persisted), correctedDocs, store);
    expect(fork.test).toEqual({ passed: true, exitCode: 0, stdout: 'PASS authentication\n', stderr: '' });
    expect(fork.source).not.toBe(original.source);
    expect(fork.source).toContain('return auth.login();');
    expect(original.source).toContain('return auth.loginLegacy();');
    expect(original.workspace).not.toBe(fork.workspace);
    expect(existsSync(original.workspace)).toBe(false); expect(existsSync(fork.workspace)).toBe(false);
    const report = compare(persisted, store.load(fork.events[0]!.traceId));
    expect(report).toMatchObject({ successRateDifference: 1, differences: { sourceChanged: true, finalStateChanged: true, files: ['solution.mjs'] } });
    expect(report.intervention).toMatchObject({ targetEventId: target(persisted), original: { api: 'auth.loginLegacy()' }, replacement: correctedDocs, checkpointFingerprint: initialSnapshot().fingerprint });
    expect(store.list()[1]!.parentTraceId).toBe(original.events[0]!.traceId);
    expect(exactReplay(fork.events).equivalent).toBe(true);
    expect(repoDigest()).toBe(before);
    store.close();
  });
  it('can reverse the observation in a child trace and genuinely fail the real test again', () => {
    const original = runLive().events;
    const successful = forkTrace(original, target(original), correctedDocs).events;
    const reversed = forkTrace(successful, target(successful), { api: 'auth.loginLegacy()' });
    expect(reversed.test.passed).toBe(false);
    expect(reversed.test.stdout).toContain('auth.loginLegacy is not a function');
    expect(compare(successful, reversed.events).successRateDifference).toBe(-1);
    expect(exactReplay(reversed.events).equivalent).toBe(true);
  });
  it('counts reproducibility trials and supports a named custom success predicate', () => {
    const events = runLive().events;
    const result = experiment({ original: events, targetEventId: target(events), replacement: correctedDocs, trials: 2,
      successPredicate: es => es.some(e => e.eventType === 'test.completed' && e.payload.passed), predicateName: 'test-passes' });
    expect(result.successCounts).toEqual({ successes: 2, failures: 0 });
    expect(result.successRateDifference).toBe(1);
    expect(result.independentStatisticalEvidence).toBe(false);
    expect(result.trials[0]!.traceId).not.toBe(result.trials[1]!.traceId);
    expect(() => experiment({ original: events, targetEventId: target(events), replacement: correctedDocs, trials: 0 })).toThrow(/Trials/);
  });
  it('rejects mismatched parents and forged original intervention values', () => {
    const original = runLive().events;
    const fork = forkTrace(original, target(original), correctedDocs).events;
    expect(() => compare(runLive().events, fork)).toThrow(/parent/);
    const forged = mutate(fork, es => { const e = es.find(e => e.eventType === 'intervention.applied'); if (e?.eventType === 'intervention.applied') e.payload.original = { api: 'auth.loginLegacy()', provenance: 'forged' }; });
    expect(() => compare(original, forged)).toThrow(/parent tool output/);
  });
});

const cli = resolve('packages/cli/dist/index.js');
function cliRun(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { cwd, timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: { TZ: 'UTC', LANG: 'C', HOME: cwd } });
}
describe('CLI end to end', () => {
  it('demonstrates, inspects, replays, compares, forks, exports and imports across independent processes', () => {
    const cwd = temp(); writeFileSync(join(cwd, 'user-file.txt'), 'untouched');
    expect(cliRun(cwd, ['--help'])).toContain('Usage: causal');
    const demo = JSON.parse(cliRun(cwd, ['demo', '--json'])) as { originalTraceId: string; forkTraceIds: string[]; reportDirectory: string };
    const [fork] = demo.forkTraceIds;
    expect(fork).toBeTruthy();
    expect(readFileSync(join(cwd, 'user-file.txt'), 'utf8')).toBe('untouched');
    expect(existsSync(join(cwd, 'solution.mjs'))).toBe(false);
    expect(JSON.parse(cliRun(cwd, ['traces', '--json']))).toHaveLength(2);
    const events = JSON.parse(cliRun(cwd, ['inspect', demo.originalTraceId, '--json'])) as ExecutionEvent[];
    expect(JSON.parse(cliRun(cwd, ['replay', demo.originalTraceId, '--json'])).equivalent).toBe(true);
    expect(JSON.parse(cliRun(cwd, ['compare', demo.originalTraceId, fork!, '--json'])).counterfactual.success).toBe(true);
    expect(readFileSync(join(demo.reportDirectory, 'report.txt'), 'utf8')).toContain('FAIL TypeError');
    expect(readFileSync(join(demo.reportDirectory, 'report.json'), 'utf8')).toContain('independentStatisticalEvidence');
    const replacement = join(cwd, 'replacement.json'); writeFileSync(replacement, JSON.stringify(correctedDocs));
    const manualFork = JSON.parse(cliRun(cwd, ['fork', demo.originalTraceId, '--event', target(events), '--replacement', replacement, '--json']));
    expect(manualFork.test.passed).toBe(true);
    const exported = join(cwd, 'export.jsonl');
    cliRun(cwd, ['export', demo.originalTraceId, '--out', exported]);
    const secondDb = join(cwd, 'import.sqlite');
    expect(JSON.parse(cliRun(cwd, ['import', exported, '--db', secondDb, '--json'])).traceId).toBe(demo.originalTraceId);
    expect(JSON.parse(cliRun(cwd, ['replay', demo.originalTraceId, '--db', secondDb, '--json'])).equivalent).toBe(true);
  });
  it('returns clear operational errors and nonzero status on malformed arguments and data', () => {
    const cwd = temp(); writeFileSync(join(cwd, 'bad.jsonl'), '{broken');
    for (const args of [['no-such-command'], ['inspect', 'missing'], ['demo', '--trials', 'NaN'], ['import', 'bad.jsonl'], ['fork', 'missing'], ['replay', 'missing', '--event', 'x']]) {
      const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd, encoding: 'utf8', timeout: 5000, env: { TZ: 'UTC', LANG: 'C', HOME: cwd } });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr).error).toBeTruthy();
    }
  });
});
